import { router, json, error, db, requireAuth, requireAdminEmailAllowlist, notifications } from '@appdeploy/sdk';
import { createHash, randomBytes } from 'node:crypto';
import { realtimeSubscriptionRoutes } from './realtime-subscribers';

const ADMIN_EMAILS = ['collkip@gmail.com'];
const hash = (value: string) => createHash('sha256').update(value.trim().toUpperCase()).digest('hex');
const nowIso = () => new Date().toISOString();
const safeText = (value: unknown, fallback = '') => String(value ?? fallback).trim();
const makeLicenseKey = () => {
  const token = randomBytes(9).toString('hex').toUpperCase();
  return `COLLKIP-${token.slice(0, 4)}-${token.slice(4, 8)}-${token.slice(8, 12)}`;
};
const makeId = (prefix: string, seed: string) => `${prefix}_${hash(seed).slice(0, 32)}`;

const recordEvent = async (event: Record<string, unknown>) => {
  await db.add('license_events', [{ ...event, createdAt: nowIso() }]);
};

const computedStatus = (license: Record<string, unknown>) => {
  const status = safeText(license.status, 'Pending Activation');
  if (status === 'Suspended' || status === 'Revoked') return status;
  const expiry = new Date(safeText(license.expiryDate)).getTime();
  if (!Number.isFinite(expiry)) return status;
  if (Date.now() <= expiry) return status === 'Pending Activation' ? 'Pending Activation' : 'Active';
  const graceDays = Math.max(0, Number(license.gracePeriodDays) || 0);
  if (Date.now() <= expiry + graceDays * 86400000) return 'Grace Period';
  return 'Expired';
};

async function activateLicense(body: Record<string, unknown>) {
  const licenseKey = safeText(body.licenseKey).toUpperCase();
  const schoolCode = safeText(body.schoolCode).toUpperCase();
  const schoolName = safeText(body.schoolName);
  const deviceId = safeText(body.deviceId);
  if (!/^COLLKIP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(licenseKey)) return error('Invalid Collkip license key format.', 400);
  if (!schoolCode || !schoolName || !deviceId) return error('School code, school name, and device ID are required.', 400);
  const licenseId = hash(licenseKey);
  const [existing] = await db.get<Record<string, unknown>>('licenses', [licenseId], { consistent: true });
  if (!existing) return error('License key was not found. Ask Collkip support to issue or renew a license.', 404);
  const status = computedStatus(existing);
  if (status === 'Suspended') return error('This license is suspended. Contact Collkip support.', 403);
  if (status === 'Revoked') return error('This license has been revoked. Contact Collkip support.', 403);
  if (status === 'Expired') return error('This license has expired. Contact Collkip support for renewal.', 403);
  const schoolId = safeText(existing.schoolId) || makeId('school', schoolCode);
  const [school] = await db.get<Record<string, unknown>>('schools', [schoolId], { consistent: true });
  if (!school) await db.tx.add('schools', [{ id: schoolId, code: schoolCode, name: schoolName, status: 'Active', createdAt: nowIso(), updatedAt: nowIso() }]);
  else if (safeText(school.code) !== schoolCode) return error('School code does not match the registered license.', 409);
  const maxDevices = Math.max(1, Number(existing.maxDevices) || 1);
  const devices = await db.list<Record<string, unknown>>('devices', { limit: Math.min(100, maxDevices + 20) });
  const licenseDevices = devices.items.filter(item => safeText(item.licenseId) === licenseId && safeText(item.status) !== 'Revoked');
  const deviceRecordId = makeId('device', `${licenseId}:${deviceId}`);
  const [currentDevice] = await db.get<Record<string, unknown>>('devices', [deviceRecordId], { consistent: true });
  if (!currentDevice && licenseDevices.length >= maxDevices) return error(`This license already has ${maxDevices} active device${maxDevices === 1 ? '' : 's'}.`, 409);
  if (!currentDevice) await db.tx.add('devices', [{ id: deviceRecordId, licenseId, schoolId, deviceId, status: 'Active', firstSeenAt: nowIso(), lastSeenAt: nowIso() }]);
  else await db.tx.update('devices', [{ id: deviceRecordId, record: { lastSeenAt: nowIso(), status: 'Active' } }], { patch: true });
  const nextStatus = status === 'Pending Activation' ? 'Active' : status;
  await db.tx.update('licenses', [{ id: licenseId, record: { schoolId, status: nextStatus, activationDate: existing.activationDate || nowIso(), lastVerification: nowIso(), updatedAt: nowIso() } }], { patch: true });
  await recordEvent({ type: 'activation', licenseId, schoolId, deviceId, source: 'desktop' });
  return json({ school: { id: schoolId, code: schoolCode, name: schoolName }, license: { ...existing, licenseId, schoolId, status: nextStatus, lastVerification: nowIso(), licenseKey: undefined }, device: { id: deviceRecordId, deviceId, status: 'Active' } });
}

async function verifyLicense(body: Record<string, unknown>) {
  const licenseId = safeText(body.licenseId);
  const deviceId = safeText(body.deviceId);
  if (!licenseId || !deviceId) return error('License ID and device ID are required.', 400);
  const [license] = await db.get<Record<string, unknown>>('licenses', [licenseId], { consistent: true });
  if (!license) return error('License not found.', 404);
  const deviceRecordId = makeId('device', `${licenseId}:${deviceId}`);
  const [device] = await db.get<Record<string, unknown>>('devices', [deviceRecordId], { consistent: true });
  if (!device || safeText(device.status) !== 'Active') return error('This device is not registered for the license.', 403);
  const status = computedStatus(license);
  const verifiedAt = nowIso();
  await db.tx.update('devices', [{ id: deviceRecordId, record: { lastSeenAt: verifiedAt } }], { patch: true });
  await db.tx.update('licenses', [{ id: licenseId, record: { lastVerification: verifiedAt, updatedAt: verifiedAt } }], { patch: true });
  await recordEvent({ type: 'verification', licenseId, schoolId: safeText(license.schoolId), deviceId, source: 'desktop' });
  return json({ license: { ...license, licenseId, status, lastVerification: verifiedAt, licenseKey: undefined }, device: { ...device, id: deviceRecordId } });
}

const verifyDesktopMobileActor = async (licenseId: string, deviceId: string) => {
  if (!licenseId || !deviceId) return { error: 'License ID and desktop device ID are required.' };
  const [license] = await db.get<Record<string, unknown>>('licenses', [licenseId], { consistent: true });
  if (!license) return { error: 'License not found.' };
  const status = computedStatus(license);
  if (!['Active', 'Grace Period'].includes(status)) return { error: `License is ${status}. Activate or renew the license before teacher synchronization.` };
  const recordId = makeId('device', `${licenseId}:${deviceId}`);
  const [device] = await db.get<Record<string, unknown>>('devices', [recordId], { consistent: true });
  if (!device || safeText(device.status) !== 'Active') return { error: 'This desktop device is not registered for the license.' };
  return { license, device, status };
};

const tokenHash = (value: string) => hash(value);
const makeMobileToken = () => randomBytes(24).toString('base64url');

type TeacherNotificationSettings = {
  morningSummary: { enabled: boolean; time: string };
  beforeLesson: { enabled: boolean; minutes: number };
  lessonEnding: { enabled: boolean; minutes: number };
  tomorrowSummary: boolean;
  timetableChanges: boolean;
};

const defaultNotificationSettings = (): TeacherNotificationSettings => ({
  morningSummary: { enabled: true, time: '06:00' },
  beforeLesson: { enabled: true, minutes: 10 },
  lessonEnding: { enabled: false, minutes: 5 },
  tomorrowSummary: false,
  timetableChanges: true,
});

const normalizeNotificationSettings = (value: unknown): TeacherNotificationSettings => {
  const base = defaultNotificationSettings();
  const input = (value || {}) as Record<string, unknown>;
  const morning = (input.morningSummary || {}) as Record<string, unknown>;
  const before = (input.beforeLesson || {}) as Record<string, unknown>;
  const ending = (input.lessonEnding || {}) as Record<string, unknown>;
  const minutes = (raw: unknown, allowed: number[], fallback: number) => { const n = Number(raw); return allowed.includes(n) ? n : fallback; };
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(safeText(morning.time)) ? safeText(morning.time) : base.morningSummary.time;
  return {
    morningSummary: { enabled: morning.enabled !== false, time },
    beforeLesson: { enabled: before.enabled !== false, minutes: minutes(before.minutes, [5, 10, 15, 20, 30], 10) },
    lessonEnding: { enabled: ending.enabled === true, minutes: minutes(ending.minutes, [5, 10, 15], 5) },
    tomorrowSummary: input.tomorrowSummary === true,
    timetableChanges: input.timetableChanges !== false,
  };
};

const localParts = (date: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'Africa/Nairobi', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  const weekday = get('weekday');
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  return { dateKey: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24, minute: Number(get('minute')), dayIndex, time: `${get('hour')}:${get('minute')}` };
};

const minutesFromHHMM = (value: string) => { const [h, m] = value.split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN; };

const parseSnapshotLessons = (snapshot: unknown) => Array.isArray((snapshot as Record<string, unknown> | undefined)?.lessons) ? (snapshot as Record<string, unknown>).lessons as Array<Record<string, unknown>> : [];

const sendTeacherNotification = async (userId: string, title: string, body: string, kind: string) => {
  if (!userId) return;
  try { await notifications.send({ userIds: [userId], notification: { title, body, url: '/?teacherMobile=1' }, data: { kind } }); }
  catch (err) { console.warn('Teacher notification delivery failed', err); }
};

export const teacherNotificationHandler = async (event: { type: 'cron'; name: string; payload: Record<string, unknown>; scheduledTime: string }) => {
  const devices = await db.list<Record<string, unknown>>('mobile_devices', { limit: 1000 });
  const now = new Date();
  for (const device of devices.items) {
    if (safeText(device.status) !== 'Active' || !safeText(device.notificationUserId)) continue;
    const settings = normalizeNotificationSettings(device.notificationSettings);
    const snapshots = await db.list<Record<string, unknown>>('mobile_snapshots', { limit: 1000 });
    const latest = snapshots.items.filter(x => safeText(x.licenseId) === safeText(device.licenseId) && safeText(x.teacherId) === safeText(device.teacherId)).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
    if (!latest?.snapshot) continue;
    const snapshot = latest.snapshot as Record<string, unknown>;
    const timezone = safeText(snapshot.timezone, 'Africa/Nairobi');
    const local = localParts(now, timezone);
    const schoolDays = Math.max(1, Math.min(7, Number(snapshot.schoolDays) || 5));
    if (local.dayIndex < 1 || local.dayIndex > schoolDays) continue;
    const lessons = parseSnapshotLessons(snapshot).filter(lesson => Number(lesson.day) === local.dayIndex - 1);
    const state = (device.notificationState || {}) as Record<string, unknown>;
    const sentKeys = { ...((state.sentKeys || {}) as Record<string, unknown>) };
    const markSent = async (key: string) => { sentKeys[key] = now.toISOString(); const keys = Object.entries(sentKeys).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, 120); await db.tx.update('mobile_devices', [{ id: safeText(device.id), record: { notificationState: { sentKeys: Object.fromEntries(keys) } } }], { patch: true }); };
    const currentMinutes = local.hour * 60 + local.minute;
    if (settings.morningSummary.enabled && local.time === settings.morningSummary.time) {
      const key = `${local.dateKey}:morning`;
      if (!sentKeys[key]) { const summary = lessons.length ? lessons.slice(0, 6).map(l => `${safeText(l.subject)} ${safeText(l.start)}–${safeText(l.end)}`).join(', ') : 'No scheduled lessons today.'; await sendTeacherNotification(safeText(device.notificationUserId), `Good morning, ${safeText(device.teacherName)}`, summary, 'morning-summary'); await markSent(key); }
    }
    for (const lesson of lessons) {
      const start = minutesFromHHMM(safeText(lesson.start));
      const end = minutesFromHHMM(safeText(lesson.end));
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (settings.beforeLesson.enabled && currentMinutes >= start - settings.beforeLesson.minutes && currentMinutes < start - settings.beforeLesson.minutes + 5) {
        const key = `${local.dateKey}:before:${safeText(lesson.periodOrder)}:${settings.beforeLesson.minutes}`;
        if (!sentKeys[key]) { await sendTeacherNotification(safeText(device.notificationUserId), `Lesson in ${settings.beforeLesson.minutes} minutes`, `${safeText(lesson.subject)} · ${safeText(lesson.className)} · ${safeText(lesson.room)}`, 'before-lesson'); await markSent(key); }
      }
      if (settings.lessonEnding.enabled && currentMinutes >= end - settings.lessonEnding.minutes && currentMinutes < end - settings.lessonEnding.minutes + 5) {
        const key = `${local.dateKey}:ending:${safeText(lesson.periodOrder)}:${settings.lessonEnding.minutes}`;
        if (!sentKeys[key]) { await sendTeacherNotification(safeText(device.notificationUserId), `Lesson ends in ${settings.lessonEnding.minutes} minutes`, `${safeText(lesson.subject)} · ${safeText(lesson.className)}`, 'lesson-ending'); await markSent(key); }
      }
    }
    if (settings.tomorrowSummary && local.time === settings.morningSummary.time) {
      const tomorrowIndex = local.dayIndex;
      const tomorrowLessons = parseSnapshotLessons(snapshot).filter(lesson => Number(lesson.day) === tomorrowIndex);
      const key = `${local.dateKey}:tomorrow`;
      if (!sentKeys[key]) { const summary = tomorrowLessons.length ? `${tomorrowLessons.length} lesson period(s) tomorrow. First: ${safeText(tomorrowLessons[0].subject)} at ${safeText(tomorrowLessons[0].start)}.` : 'No scheduled lessons tomorrow.'; await sendTeacherNotification(safeText(device.notificationUserId), 'Tomorrow at a glance', summary, 'tomorrow-summary'); await markSent(key); }
    }
  }
  return { statusCode: 200 };
};

async function createMobilePairing(body: Record<string, unknown>) {
  const licenseId = safeText(body.licenseId);
  const deviceId = safeText(body.deviceId);
  const actor = await verifyDesktopMobileActor(licenseId, deviceId);
  if (actor.error) return error(actor.error, 403);
  const schoolCode = safeText(body.schoolCode).toUpperCase();
  const teacherId = safeText(body.teacherId);
  const teacherCode = safeText(body.teacherCode);
  const teacherName = safeText(body.teacherName);
  const snapshot = body.snapshot as Record<string, unknown> | undefined;
  if (!schoolCode || !teacherId || !teacherCode || !teacherName || !snapshot) return error('School code, teacher identity, and timetable snapshot are required.', 400);
  if (safeText(actor.license.schoolId) !== makeId('school', schoolCode)) return error('School code does not match the active license.', 409);
  if (safeText(snapshot.teacherId) !== teacherId) return error('Teacher timetable snapshot does not match the selected teacher.', 400);
  const lessons = Array.isArray(snapshot.lessons) ? snapshot.lessons : [];
  if (!lessons.length) return error('The selected teacher has no scheduled lessons in the validated timetable.', 400);
  if (JSON.stringify(snapshot).length > 200000) return error('Teacher timetable snapshot is too large.', 413);
  const token = makeMobileToken();
  const pairingId = makeId('mobile-pairing', token);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await db.tx.add('mobile_pairings', [{ id: pairingId, tokenHash: tokenHash(token), schoolId: safeText(actor.license.schoolId), licenseId, teacherId, teacherCode, teacherName, snapshot, snapshotVersion: safeText(snapshot.version) || nowIso(), status: 'Pending', expiresAt, createdAt: nowIso(), createdByDeviceId: deviceId }]);
  return json({ pairingId, token, expiresAt, teacher: { id: teacherId, code: teacherCode, name: teacherName }, lessonCount: lessons.length });
}

async function claimMobilePairing(body: Record<string, unknown>) {
  const token = safeText(body.token);
  const deviceName = safeText(body.deviceName, 'Teacher phone').slice(0, 120);
  if (!token) return error('Pairing token is required.', 400);
  const [pairing] = await db.get<Record<string, unknown>>('mobile_pairings', [makeId('mobile-pairing', token)], { consistent: true });
  if (!pairing) return error('Pairing link is invalid or has already been used.', 404);
  if (safeText(pairing.status) !== 'Pending') return error('This pairing link has already been claimed or revoked.', 409);
  if (Date.now() > new Date(safeText(pairing.expiresAt)).getTime()) {
    await db.tx.update('mobile_pairings', [{ id: safeText(pairing.id), record: { status: 'Expired', updatedAt: nowIso() } }], { patch: true });
    return error('This pairing link has expired. Ask the school administrator for a new QR code.', 410);
  }
  const accessToken = makeMobileToken();
  const mobileDeviceId = makeId('mobile-device', accessToken);
  await db.tx.add('mobile_devices', [{ id: mobileDeviceId, accessTokenHash: tokenHash(accessToken), schoolId: safeText(pairing.schoolId), licenseId: safeText(pairing.licenseId), teacherId: safeText(pairing.teacherId), teacherCode: safeText(pairing.teacherCode), teacherName: safeText(pairing.teacherName), deviceName, status: 'Active', pairedAt: nowIso(), lastSeenAt: nowIso(), snapshotVersion: safeText(pairing.snapshotVersion) }]);
  await db.tx.update('mobile_pairings', [{ id: safeText(pairing.id), record: { status: 'Claimed', claimedAt: nowIso(), mobileDeviceId, updatedAt: nowIso() } }], { patch: true });
  await recordEvent({ type: 'mobile_device_paired', licenseId: safeText(pairing.licenseId), schoolId: safeText(pairing.schoolId), teacherId: safeText(pairing.teacherId), mobileDeviceId, source: 'teacher_mobile' });
  const snapshot = pairing.snapshot as Record<string, unknown>;
  return json({ accessToken, teacher: { id: safeText(pairing.teacherId), code: safeText(pairing.teacherCode), name: safeText(pairing.teacherName), email: safeText(snapshot.teacherEmail) }, school: { id: safeText(pairing.schoolId), code: safeText(snapshot.schoolCode), name: safeText(snapshot.schoolName) }, snapshot, snapshotVersion: safeText(pairing.snapshotVersion), notificationSettings: defaultNotificationSettings() });
}

async function syncMobileDevice(body: Record<string, unknown>) {
  const accessToken = safeText(body.accessToken);
  if (!accessToken) return error('Mobile access token is required.', 400);
  const [device] = await db.get<Record<string, unknown>>('mobile_devices', [makeId('mobile-device', accessToken)], { consistent: true });
  if (!device || safeText(device.status) !== 'Active') return error('This teacher mobile device is revoked or no longer registered.', 403);
  const licenseId = safeText(device.licenseId);
  const [license] = await db.get<Record<string, unknown>>('licenses', [licenseId], { consistent: true });
  const licenseStatus = license ? computedStatus(license) : 'Expired';
  if (!['Active', 'Grace Period'].includes(licenseStatus)) return error(`School license is ${licenseStatus}.`, 403);
  const snapshots = await db.list<Record<string, unknown>>('mobile_snapshots', { limit: 100 });
  const latest = snapshots.items.filter(x => safeText(x.licenseId) === licenseId && safeText(x.teacherId) === safeText(device.teacherId)).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
  const fallbackPairings = await db.list<Record<string, unknown>>('mobile_pairings', { limit: 100 });
  const claimed = fallbackPairings.items.filter(x => safeText(x.licenseId) === licenseId && safeText(x.teacherId) === safeText(device.teacherId) && safeText(x.status) === 'Claimed').sort((a, b) => String(b.claimedAt || '').localeCompare(String(a.claimedAt || '')))[0];
  const snapshot = latest?.snapshot || claimed?.snapshot;
  if (!snapshot) return error('No timetable snapshot is available for this teacher yet.', 404);
  const version = safeText((snapshot as Record<string, unknown>).version, safeText(device.snapshotVersion));
  await db.tx.update('mobile_devices', [{ id: safeText(device.id), record: { lastSeenAt: nowIso(), snapshotVersion: version } }], { patch: true });
  return json({ status: 'Active', snapshot, snapshotVersion: version });
}

async function pushMobileSnapshot(body: Record<string, unknown>) {
  const licenseId = safeText(body.licenseId);
  const deviceId = safeText(body.deviceId);
  const actor = await verifyDesktopMobileActor(licenseId, deviceId);
  if (actor.error) return error(actor.error, 403);
  const teacherId = safeText(body.teacherId);
  const snapshot = body.snapshot as Record<string, unknown> | undefined;
  if (!teacherId || !snapshot || safeText(snapshot.teacherId) !== teacherId) return error('Teacher ID and matching timetable snapshot are required.', 400);
  if (JSON.stringify(snapshot).length > 200000) return error('Teacher timetable snapshot is too large.', 413);
  const snapshotId = makeId('mobile-snapshot', `${licenseId}:${teacherId}`);
  const [existing] = await db.get<Record<string, unknown>>('mobile_snapshots', [snapshotId], { consistent: true });
  if (!existing) await db.tx.add('mobile_snapshots', [{ id: snapshotId, licenseId, schoolId: safeText(actor.license.schoolId), teacherId, snapshot, updatedAt: nowIso() }]);
  else await db.tx.update('mobile_snapshots', [{ id: snapshotId, record: { snapshot, updatedAt: nowIso() } }], { patch: true });
  const devices = await db.list<Record<string, unknown>>('mobile_devices', { limit: 1000 });
  const targets = devices.items.filter(x => safeText(x.licenseId) === licenseId && safeText(x.teacherId) === teacherId && safeText(x.status) === 'Active');
  for (const target of targets) await db.tx.update('mobile_devices', [{ id: safeText(target.id), record: { snapshotVersion: safeText(snapshot.version) || nowIso() } }], { patch: true });
  await recordEvent({ type: 'mobile_snapshot_pushed', licenseId, schoolId: safeText(actor.license.schoolId), teacherId, deviceId, source: 'desktop' });
  return json({ updatedDevices: targets.length, snapshotVersion: safeText(snapshot.version) });
}

async function listMobileDevices(body: Record<string, unknown>) {
  const actor = await verifyDesktopMobileActor(safeText(body.licenseId), safeText(body.deviceId));
  if (actor.error) return error(actor.error, 403);
  const devices = await db.list<Record<string, unknown>>('mobile_devices', { limit: 1000 });
  return json({ devices: devices.items.filter(x => safeText(x.licenseId) === safeText(body.licenseId)).map(x => ({ ...x, accessTokenHash: undefined })) });
}

async function registerMobileNotifications(body: Record<string, unknown>, userId: string, userEmail: string) {
  const accessToken = safeText(body.accessToken);
  const settings = normalizeNotificationSettings(body.settings);
  if (!accessToken || !userId || !userEmail) return error('A paired mobile device and authenticated teacher account are required.', 400);
  const [device] = await db.get<Record<string, unknown>>('mobile_devices', [makeId('mobile-device', accessToken)], { consistent: true });
  if (!device || safeText(device.status) !== 'Active') return error('This teacher mobile device is revoked or no longer registered.', 403);
  const snapshots = await db.list<Record<string, unknown>>('mobile_snapshots', { limit: 1000 });
  const latest = snapshots.items.filter(x => safeText(x.licenseId) === safeText(device.licenseId) && safeText(x.teacherId) === safeText(device.teacherId)).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
  const teacherEmail = safeText((latest?.snapshot as Record<string, unknown> | undefined)?.teacherEmail).toLowerCase();
  if (teacherEmail && teacherEmail !== userEmail.toLowerCase()) return error('The signed-in email does not match this teacher record.', 403);
  await db.tx.update('mobile_devices', [{ id: safeText(device.id), record: { notificationUserId: userId, notificationEmail: userEmail.toLowerCase(), notificationSettings: settings, notificationState: device.notificationState || { sentKeys: {} }, updatedAt: nowIso() } }], { patch: true });
  return json({ enabled: true, settings });
}

async function testTeacherNotification(userId: string) {
  await sendTeacherNotification(userId, 'Collkip notifications are working', 'This is a test notification from your teacher timetable.', 'test');
  return json({ sent: true });
}

async function revokeMobileDevice(body: Record<string, unknown>) {
  const actor = await verifyDesktopMobileActor(safeText(body.licenseId), safeText(body.deviceId));
  if (actor.error) return error(actor.error, 403);
  const mobileDeviceId = safeText(body.mobileDeviceId);
  const [device] = await db.get<Record<string, unknown>>('mobile_devices', [mobileDeviceId], { consistent: true });
  if (!device || safeText(device.licenseId) !== safeText(body.licenseId)) return error('Teacher mobile device not found.', 404);
  await db.tx.update('mobile_devices', [{ id: mobileDeviceId, record: { status: 'Revoked', revokedAt: nowIso(), updatedAt: nowIso() } }], { patch: true });
  await recordEvent({ type: 'mobile_device_revoked', licenseId: safeText(body.licenseId), schoolId: safeText(actor.license.schoolId), teacherId: safeText(device.teacherId), mobileDeviceId, source: 'desktop' });
  return json({ id: mobileDeviceId, status: 'Revoked' });
}

const admin = [requireAuth(), requireAdminEmailAllowlist(ADMIN_EMAILS)];

export const handler = router({
  'GET /api/_healthcheck': [async () => json({ message: 'Success' })],
  'POST /api/licensing/activate': [async ({ body }) => activateLicense((body || {}) as Record<string, unknown>)],
  'POST /api/licensing/verify': [async ({ body }) => verifyLicense((body || {}) as Record<string, unknown>)],
  'POST /api/mobile/pairings': [async ({ body }) => createMobilePairing((body || {}) as Record<string, unknown>)],
  'POST /api/mobile/pairings/claim': [async ({ body }) => claimMobilePairing((body || {}) as Record<string, unknown>)],
  'POST /api/mobile/sync': [async ({ body }) => syncMobileDevice((body || {}) as Record<string, unknown>)],
  'POST /api/mobile/push': [async ({ body }) => pushMobileSnapshot((body || {}) as Record<string, unknown>)],
  'POST /api/mobile/devices/list': [async ({ body }) => listMobileDevices((body || {}) as Record<string, unknown>)],
  'POST /api/mobile/devices/revoke': [async ({ body }) => revokeMobileDevice((body || {}) as Record<string, unknown>)],
  'GET /api/admin/overview': [...admin, async () => {
    const [schools, licenses, devices] = await Promise.all([db.list<Record<string, unknown>>('schools', { limit: 100 }), db.list<Record<string, unknown>>('licenses', { limit: 100 }), db.list<Record<string, unknown>>('devices', { limit: 100 })]);
    return json({ schools: schools.items.length, licenses: licenses.items.length, activeLicenses: licenses.items.filter(x => computedStatus(x) === 'Active').length, devices: devices.items.filter(x => safeText(x.status) === 'Active').length });
  }],
  'GET /api/admin/schools': [...admin, async () => json((await db.list<Record<string, unknown>>('schools', { limit: 100 })).items)],
  'GET /api/admin/licenses': [...admin, async () => json((await db.list<Record<string, unknown>>('licenses', { limit: 100 })).items.map(x => ({ ...x, status: computedStatus(x), licenseKey: undefined })))],
  'GET /api/admin/devices': [...admin, async () => json((await db.list<Record<string, unknown>>('devices', { limit: 100 })).items)],
  'GET /api/admin/events': [...admin, async () => json((await db.list<Record<string, unknown>>('license_events', { limit: 100 })).items)],
  'POST /api/admin/licenses': [...admin, async ({ body }) => {
    const input = (body || {}) as Record<string, unknown>;
    const schoolName = safeText(input.schoolName);
    const schoolCode = safeText(input.schoolCode).toUpperCase();
    const licenseType = safeText(input.licenseType, 'Annual');
    const days = Math.min(3650, Math.max(1, Number(input.durationDays) || 365));
    const maxDevices = Math.min(100, Math.max(1, Number(input.maxDevices) || 1));
    const gracePeriodDays = Math.min(90, Math.max(0, Number(input.gracePeriodDays) || 14));
    if (!schoolName || !schoolCode) return error('School name and school code are required.', 400);
    const schoolId = makeId('school', schoolCode);
    const existingSchool = (await db.get<Record<string, unknown>>('schools', [schoolId], { consistent: true }))[0];
    if (!existingSchool) await db.tx.add('schools', [{ id: schoolId, code: schoolCode, name: schoolName, status: 'Active', createdAt: nowIso(), updatedAt: nowIso() }]);
    const licenseKey = makeLicenseKey();
    const licenseId = hash(licenseKey);
    const createdAt = nowIso();
    const expiryDate = new Date(Date.now() + days * 86400000).toISOString();
    await db.tx.add('licenses', [{ id: licenseId, schoolId, schoolName, licenseType, status: 'Pending Activation', activationDate: '', expiryDate, maxDevices, gracePeriodDays, createdAt, updatedAt: createdAt, issuedBy: 'collkip@gmail.com', licenseKeyLast4: licenseKey.slice(-4) }]);
    await recordEvent({ type: 'license_issued', licenseId, schoolId, source: 'super_admin', actorEmail: 'collkip@gmail.com' });
    return json({ licenseId, licenseKey, schoolId, schoolName, schoolCode, licenseType, status: 'Pending Activation', expiryDate, maxDevices, gracePeriodDays }, 201);
  }],
  'POST /api/admin/licenses/:id/action': [...admin, async ({ params, body }) => {
    const licenseId = safeText(params.id);
    const input = (body || {}) as Record<string, unknown>;
    const action = safeText(input.action).toLowerCase();
    const [license] = await db.get<Record<string, unknown>>('licenses', [licenseId], { consistent: true });
    if (!license) return error('License not found.', 404);
    if (!['activate', 'suspend', 'revoke', 'renew'].includes(action)) return error('Unsupported license action.', 400);
    const patch: Record<string, unknown> = { updatedAt: nowIso() };
    if (action === 'activate') patch.status = 'Active';
    if (action === 'suspend') patch.status = 'Suspended';
    if (action === 'revoke') patch.status = 'Revoked';
    if (action === 'renew') {
      const days = Math.min(3650, Math.max(1, Number(input.durationDays) || 365));
      const base = Math.max(Date.now(), new Date(safeText(license.expiryDate)).getTime() || Date.now());
      patch.expiryDate = new Date(base + days * 86400000).toISOString();
      patch.status = 'Active';
    }
    await db.tx.update('licenses', [{ id: licenseId, record: patch }], { patch: true });
    await recordEvent({ type: `license_${action}`, licenseId, schoolId: safeText(license.schoolId), source: 'super_admin', actorEmail: 'collkip@gmail.com' });
    return json({ ...license, ...patch, licenseId });
  }],
  'POST /api/admin/devices/:id/revoke': [...admin, async ({ params }) => {
    const id = safeText(params.id);
    const [device] = await db.get<Record<string, unknown>>('devices', [id], { consistent: true });
    if (!device) return error('Device not found.', 404);
    await db.tx.update('devices', [{ id, record: { status: 'Revoked', updatedAt: nowIso() } }], { patch: true });
    await recordEvent({ type: 'device_revoked', licenseId: safeText(device.licenseId), schoolId: safeText(device.schoolId), deviceId: safeText(device.deviceId), source: 'super_admin', actorEmail: 'collkip@gmail.com' });
    return json({ ...device, id, status: 'Revoked' });
  }],
  ...realtimeSubscriptionRoutes,
});
