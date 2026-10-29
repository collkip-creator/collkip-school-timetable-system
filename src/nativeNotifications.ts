import { Capacitor } from '@capacitor/core';
import { LocalNotifications, type LocalNotificationSchema } from '@capacitor/local-notifications';

type Lesson = { day: number; periodOrder: number; periodName: string; start: string; end: string; subject: string; className: string; room: string };
type Snapshot = { teacherName: string; schoolName: string; schoolDays: number; timezone?: string; lessons: Lesson[] };
type Settings = { morningSummary: { enabled: boolean; time: string }; beforeLesson: { enabled: boolean; minutes: number }; lessonEnding: { enabled: boolean; minutes: number }; tomorrowSummary: boolean; timetableChanges: boolean };

const CHANNEL_ID = 'collkip-lessons';
const isNativeAndroid = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

export async function getNativeNotificationStatus() {
  if (!isNativeAndroid()) return { supported: false, granted: false, message: 'Install the Collkip Android APK for native local notifications.' };
  const permission = await LocalNotifications.checkPermissions();
  return { supported: true, granted: permission.display === 'granted', message: permission.display === 'granted' ? 'Android local notifications are allowed' : `Android notification permission: ${permission.display}` };
}

export async function requestLocalNotificationPermission() {
  if (!isNativeAndroid()) return { granted: false, message: 'Native reminders require the Collkip Android APK; browser notifications are not used.' };
  const current = await LocalNotifications.checkPermissions();
  const permission = current.display === 'granted' ? current : await LocalNotifications.requestPermissions();
  if (permission.display !== 'granted') return { granted: false, message: 'Allow notifications for Collkip in Android settings, then try again.' };
  await LocalNotifications.createChannel({ id: CHANNEL_ID, name: 'Lesson reminders', description: 'Local Collkip teacher timetable reminders', importance: 4, visibility: 1, sound: undefined, vibration: true });
  return { granted: true, message: 'Permission granted' };
}

const parseTime = (value: string) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || '');
  if (!match) return null;
  const hour = Number(match[1]); const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
};

const atLocalTime = (date: Date, value: string) => {
  const time = parseTime(value);
  if (!time) return null;
  const result = new Date(date);
  result.setHours(time.hour, time.minute, 0, 0);
  return result;
};

const dayIndex = (date: Date) => (date.getDay() + 6) % 7;
const stableId = (seed: string) => { let hash = 2166136261; for (let i = 0; i < seed.length; i += 1) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619); return (Math.abs(hash) % 2000000000) + 1; };

function buildSchedule(snapshot: Snapshot, settings: Settings): LocalNotificationSchema[] {
  const now = Date.now();
  const output: LocalNotificationSchema[] = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const lessons = Array.isArray(snapshot.lessons) ? snapshot.lessons : [];
  const maxDays = Math.max(1, Math.min(7, Number(snapshot.schoolDays) || 5));
  for (let offset = 0; offset < 14; offset += 1) {
    const date = new Date(today); date.setDate(today.getDate() + offset);
    const weekday = dayIndex(date);
    if (weekday >= maxDays) continue;
    const todaysLessons = lessons.filter(lesson => Number(lesson.day) === weekday).sort((a, b) => Number(a.periodOrder) - Number(b.periodOrder));
    if (settings.morningSummary.enabled) {
      const at = atLocalTime(date, settings.morningSummary.time);
      if (at && at.getTime() > now) {
        const summary = todaysLessons.length ? todaysLessons.slice(0, 5).map(lesson => `${lesson.start} ${lesson.subject} (${lesson.className})`).join(' · ') : 'No scheduled lessons today.';
        output.push({ id: stableId(`morning:${date.toDateString()}`), title: `Good morning, ${snapshot.teacherName}`, body: summary, schedule: { at }, channelId: CHANNEL_ID, extra: { kind: 'morning-summary' } });
      }
    }
    for (const lesson of todaysLessons) {
      const start = atLocalTime(date, lesson.start);
      const end = atLocalTime(date, lesson.end);
      if (!start || !end) continue;
      if (settings.beforeLesson.enabled) {
        const at = new Date(start.getTime() - settings.beforeLesson.minutes * 60000);
        if (at.getTime() > now) output.push({ id: stableId(`before:${date.toDateString()}:${lesson.periodOrder}:${lesson.subject}:${settings.beforeLesson.minutes}`), title: `Lesson in ${settings.beforeLesson.minutes} minutes`, body: `${lesson.subject} · ${lesson.className} · ${lesson.room}`, schedule: { at }, channelId: CHANNEL_ID, extra: { kind: 'before-lesson' } });
      }
      if (settings.lessonEnding.enabled) {
        const at = new Date(end.getTime() - settings.lessonEnding.minutes * 60000);
        if (at.getTime() > now) output.push({ id: stableId(`ending:${date.toDateString()}:${lesson.periodOrder}:${lesson.subject}:${settings.lessonEnding.minutes}`), title: `Lesson ends in ${settings.lessonEnding.minutes} minutes`, body: `${lesson.subject} · ${lesson.className}`, schedule: { at }, channelId: CHANNEL_ID, extra: { kind: 'lesson-ending' } });
      }
    }
    if (settings.tomorrowSummary) {
      const at = atLocalTime(date, '18:00');
      if (at && at.getTime() > now) {
        const tomorrow = new Date(date); tomorrow.setDate(date.getDate() + 1);
        const nextDayLessons = lessons.filter(lesson => Number(lesson.day) === dayIndex(tomorrow)).sort((a, b) => Number(a.periodOrder) - Number(b.periodOrder));
        const body = nextDayLessons.length ? `${nextDayLessons.length} lesson period(s) tomorrow. First: ${nextDayLessons[0].subject} at ${nextDayLessons[0].start}.` : 'No scheduled lessons tomorrow.';
        output.push({ id: stableId(`tomorrow:${date.toDateString()}`), title: 'Tomorrow at a glance', body, schedule: { at }, channelId: CHANNEL_ID, extra: { kind: 'tomorrow-summary' } });
      }
    }
  }
  return output;
}

export async function scheduleTeacherReminders(snapshot: Snapshot, settings: Settings) {
  if (!isNativeAndroid()) throw new Error('Native local reminders require the Collkip Android APK.');
  const permission = await LocalNotifications.checkPermissions();
  if (permission.display !== 'granted') throw new Error('Allow notifications for Collkip in Android settings, then enable reminders again.');
  const pending = await LocalNotifications.getPending();
  if (pending.notifications.length) await LocalNotifications.cancel({ notifications: pending.notifications.map(item => ({ id: item.id })) });
  const schedule = buildSchedule(snapshot, settings);
  if (schedule.length) await LocalNotifications.schedule({ notifications: schedule });
  return { scheduled: schedule.length };
}

export async function showLocalTestNotification() {
  if (!isNativeAndroid()) throw new Error('Install the Collkip Android APK to test native local notifications.');
  const permission = await LocalNotifications.checkPermissions();
  if (permission.display !== 'granted') throw new Error('Notification permission is not granted.');
  await LocalNotifications.schedule({ notifications: [{ id: stableId(`test:${Date.now()}`), title: 'Collkip notifications are working', body: 'This reminder was scheduled locally on your phone.', schedule: { at: new Date(Date.now() + 1500) }, channelId: CHANNEL_ID, extra: { kind: 'test' } }] });
}

export async function showTimetableChangedNotification() {
  if (!isNativeAndroid()) return;
  const permission = await LocalNotifications.checkPermissions();
  if (permission.display !== 'granted') return;
  await LocalNotifications.schedule({ notifications: [{ id: stableId(`change:${Date.now()}`), title: 'Your timetable changed', body: 'A new timetable was received. Your lesson reminders have been updated.', schedule: { at: new Date(Date.now() + 1200) }, channelId: CHANNEL_ID, extra: { kind: 'timetable-change' } }] });
}
