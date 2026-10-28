export type ScheduledPart = { requirementId: string; classId: string; subjectId: string; teacherId: string; roomId: string; day: number; periodOrders: number[]; periodIds: string[]; divisionId?: string; divisionMemberId?: string; studentGroupId?: string; divisionSyncGroupId?: string; combinedGroupId?: string; divisionDoublePairId?: string; lessonBlockType?: 'Single' | 'Double'; doublePart?: 1 | 2 };
export type ScheduleResult = { status: 'Complete' | 'Partial' | 'Blocked' | 'Search limit reached'; placements: ScheduledPart[]; scheduledPeriods: number; unscheduled: { requirementId: string; label: string; reason: string }[]; violations: string[]; softScore: number; exploredNodes: number; searchMode?: 'Quick' | 'Deep'; searchBudget?: number; budgetExhausted?: boolean; optimalityProven?: boolean; searchStats?: { candidateChecks: number; conflictChecks: number; prunedBranches: number }; message: string };
type AnyRecord = Record<string, any>;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const mins = (t: string) => { const a = String(t || '').split(':').map(Number); return (a[0] || 0) * 60 + (a[1] || 0); };
const overlaps = (a: AnyRecord, b: AnyRecord) => mins(a.start) < mins(b.end) && mins(b.start) < mins(a.end);
const unique = <T,>(xs: T[]) => Array.from(new Set(xs));
type Unit = { key: string; reqs: AnyRecord[]; ordinal: number; duration: number; label: string; slotReqs?: AnyRecord[][]; doubleReqIds?: string[]; lessonBlockType?: 'Single' | 'Double'; doublePart?: 1 | 2; adjacencyKey?: string; adjacencyPart?: 1 | 2 };
type Candidate = { day: number; orders: number[]; periods: AnyRecord[]; rooms: string[]; score: number; tieBreak: number };
function effectiveRequirements(data: AnyRecord): AnyRecord[] {
  const all = (data.requirements || []).filter((r: AnyRecord) => r.status === 'Active');
  const divisions = (data.divisions || []).filter((d: AnyRecord) => d.status === 'Active');
  const isDivisionRequirement = (r: AnyRecord) => divisions.some((d: AnyRecord) => r.divisionId === d.id || (d.members || []).some((m: AnyRecord) => r.classId === d.classId && r.subjectId === m.subjectId && r.teacherId === m.teacherId));
  const result = all.filter((r: AnyRecord) => !isDivisionRequirement(r));
  divisions.forEach((d: AnyRecord) => (d.members || []).filter((m: AnyRecord) => m.status !== 'Inactive').forEach((m: AnyRecord) => {
    const total = Math.max(0, Number(m.lessonsPerWeek) || 0);
    const studentGroupId = String(m.studentGroupId || (d.id + ':group:' + m.id));
    const syncName = String(m.syncGroupId || '').trim();
    const shared = syncName ? Math.max(0, Math.min(total, Number(m.sharedPeriodsPerWeek) || 0)) : 0;
    const independent = total - shared;
    const configuredDoubles = Number(m.doubleLessonsPerWeek ?? (m.lessonPattern === 'Double required' ? Math.floor(total / 2) : 0));
    // Allocate configured doubles within each segment first. A cross-boundary
    // double is only necessary when the shared and independent segments' separate
    // capacities cannot accommodate the requested count (typically both segments
    // have odd lengths). This keeps doubles inside synchronized lessons when possible.
    const sharedDoubleCapacity = Math.floor(shared / 2);
    const independentDoubleCapacity = Math.floor(independent / 2);
    // When a member has an odd independent tail and an even shared segment,
    // preserve the shared division slots by allowing one configured double to
    // cross the shared/independent boundary. Its first half remains synchronized
    // with the division; its second half continues alone. This is derived only
    // from the member's configured counts, never from subject or class names.
    const needsCrossBoundaryDouble = configuredDoubles > sharedDoubleCapacity + independentDoubleCapacity
      || (configuredDoubles > 0 && shared > 0 && independent > 0 && shared % 2 === 0 && independent % 2 === 1);
    const crossBoundaryDouble = shared > 0 && independent > 0 && needsCrossBoundaryDouble ? 1 : 0;
    const remainingDoubles = configuredDoubles - crossBoundaryDouble;
    const sharedDoubles = Math.min(sharedDoubleCapacity, remainingDoubles);
    const independentDoubles = Math.min(independentDoubleCapacity, Math.max(0, remainingDoubles - sharedDoubles));
    const pairId = crossBoundaryDouble ? d.id + ':' + m.id + ':cross-double' : '';
    const common = { classId: d.classId, subjectId: m.subjectId, teacherId: m.teacherId, lessonPattern: m.lessonPattern || 'Single lessons only', frequencyRule: 'Automatic', roomRequirement: m.roomRequirement || 'No specific room', preferredRoomId: m.preferredRoomId || '', requiredRoomType: m.requiredRoomType || '', useHomeRoom: Boolean(m.useHomeRoom), divisionId: d.id, divisionMemberId: m.id, studentGroupId, priority: Number(m.priority || 2), status: 'Active', notes: d.name + ' division member' };
    if (shared > 0) result.push({ ...common, id: 'division:' + d.id + ':' + m.id + ':shared', lessonsPerWeek: shared, doubleLessonsPerWeek: sharedDoubles, divisionSyncGroupId: d.id + ':' + syncName, crossDoublePairId: pairId, crossDoublePart: crossBoundaryDouble ? 1 : undefined });
    if (independent > 0) result.push({ ...common, id: 'division:' + d.id + ':' + m.id + ':independent', lessonsPerWeek: independent, doubleLessonsPerWeek: independentDoubles, divisionSyncGroupId: '', crossDoublePairId: pairId, crossDoublePart: crossBoundaryDouble ? 2 : undefined });
  }));
  return result;
}
export async function generateSchedule(data: AnyRecord, constraints: AnyRecord[], parallelRules: AnyRecord[], budget = 50000, deepSearch = false): Promise<ScheduleResult> {
  const placements: ScheduledPart[] = [];
  const unscheduled: ScheduleResult['unscheduled'] = [];
  const violations: string[] = [];
  const activeReqs = effectiveRequirements(data);
  const activeClasses = (data.classes || []).filter((x: AnyRecord) => x.status === 'Active');
  const activeTeachers = (data.teachers || []).filter((x: AnyRecord) => x.status === 'Active');
  const activeSubjects = (data.subjects || []).filter((x: AnyRecord) => x.status === 'Active');
  const activeRooms = (data.rooms || []).filter((x: AnyRecord) => x.status === 'Active');
  const activeSchedules = (data.schedules || []).filter((x: AnyRecord) => x.status === 'Active');
  const days = Math.max(1, Math.min(7, Number(data.schoolDays || data.profile?.schoolDays || 5)));
  const getClass = (id: string) => activeClasses.find((x: AnyRecord) => x.id === id);
  const getSubject = (id: string) => activeSubjects.find((x: AnyRecord) => x.id === id);
  const getTeacher = (id: string) => activeTeachers.find((x: AnyRecord) => x.id === id);
  const addBlocker = (s: string) => { if (!violations.includes(s)) violations.push(s); };
  if (!activeReqs.length) addBlocker('No active Weekly Requirements were found.');
  activeReqs.forEach((r: AnyRecord) => {
    const c = getClass(r.classId), s = getSubject(r.subjectId), t = getTeacher(r.teacherId);
    if (!c || !s || !t) addBlocker('A weekly requirement refers to a missing or inactive class, subject, or teacher (' + r.id + ').');
    if (c && !activeSchedules.some((x: AnyRecord) => x.id === c.scheduleId)) addBlocker('Class ' + c.name + ' has no active bell schedule.');
    if (s && t && !(data.teacherSubjects || []).some((x: AnyRecord) => x.teacherId === t.id && x.subjectId === s.id)) addBlocker(t.name + ' is not qualified for ' + s.name + '.');
    if (!Number.isInteger(Number(r.lessonsPerWeek)) || Number(r.lessonsPerWeek) < 1) addBlocker('Weekly lesson count must be a positive whole number (' + r.id + ').');
    const doubleCount = Number(r.doubleLessonsPerWeek ?? ((r.lessonPattern === 'Double required') ? Math.floor(Number(r.lessonsPerWeek || 0) / 2) : 0));
    if (doubleCount > 0 && s && !s.acceptsDoubleLesson) addBlocker(s.name + ' does not allow double lessons (' + r.id + ').');
    if (!Number.isInteger(doubleCount) || doubleCount < 0 || doubleCount > Math.floor(Number(r.lessonsPerWeek || 0) / 2)) addBlocker('Double lessons per week must be a whole number between 0 and ' + Math.floor(Number(r.lessonsPerWeek || 0) / 2) + ' (' + r.id + ').');
  });
  const activeDivisions = (data.divisions || []).filter((x: AnyRecord) => x.status === 'Active');
  activeDivisions.forEach((d: AnyRecord) => {
    if (!Array.isArray(d.members) || d.members.filter((m: AnyRecord) => m.status !== 'Inactive').length < 2) addBlocker('Division ' + d.name + ' needs at least two active members. Open Divisions and add the missing subject members.');
    const members = (d.members || []).filter((m: AnyRecord) => m.status !== 'Inactive');
    members.forEach((m: AnyRecord) => {
      const total = Number(m.lessonsPerWeek);
      const shared = Number(m.sharedPeriodsPerWeek || 0);
      if (!m.subjectId || !m.teacherId) addBlocker('Division ' + d.name + ' has a member with a missing subject or teacher. Edit the division member.');
      const memberSubject = getSubject(m.subjectId);
      const doubleCount = Number(m.doubleLessonsPerWeek ?? (m.lessonPattern === 'Double required' ? Math.floor(total / 2) : 0));
      if (!Number.isInteger(total) || total < 1) addBlocker('Division ' + d.name + ' member ' + m.id + ' must have a positive whole-number weekly lesson count.');
      if (!Number.isInteger(doubleCount) || doubleCount < 0 || doubleCount > Math.floor(total / 2)) addBlocker('Division ' + d.name + ' member ' + m.id + ' has an invalid double-lesson count.');
      if (doubleCount > 0 && memberSubject && !memberSubject.acceptsDoubleLesson) addBlocker('Division ' + d.name + ' member ' + m.id + ' requests doubles for a subject that does not allow double lessons.');
      if (shared > 0 && total - shared > 0 && doubleCount - 1 > Math.floor(shared / 2) + Math.floor((total - shared) / 2)) addBlocker('Division ' + d.name + ' member ' + m.id + ' cannot fit its configured double lessons within its shared and independent lesson counts.');
      if (!Number.isInteger(shared) || shared < 0 || shared > total) addBlocker('Division ' + d.name + ' member ' + m.id + ' has an invalid shared-period count; it must be between zero and that member’s weekly count.');
      if (shared > 0 && !String(m.syncGroupId || '').trim()) addBlocker('Division ' + d.name + ' member ' + m.id + ' specifies shared periods but no synchronization set. Choose a Shared Set in Divisions.');
    });
    const syncNames = unique(members.map((m: AnyRecord) => String(m.syncGroupId || '').trim()).filter(Boolean));
    syncNames.forEach(syncName => {
      const linked = members.filter((m: AnyRecord) => String(m.syncGroupId || '').trim() === syncName && Number(m.sharedPeriodsPerWeek || 0) > 0);
      if (linked.length < 2) addBlocker('Division ' + d.name + ' synchronization set ' + syncName + ' must include at least two members with shared periods.');
      if (unique(linked.map((m: AnyRecord) => Number(m.sharedPeriodsPerWeek || 0))).length > 1) addBlocker('Division ' + d.name + ' synchronization set ' + syncName + ' has inconsistent shared lesson counts. Set the same shared-period count for every linked member.');
    });
  });
  const enabledRules = (parallelRules || []).filter((x: AnyRecord) => x.enabled);
  const enabledConstraints = (constraints || []).filter((x: AnyRecord) => x.enabled && x.classification === 'Hard');
  // Constraints are data, not scheduler source-code branches. A rule may declare
  // applicability through scope/teacherIds/classIds/subjectIds and express common
  // placement restrictions through parameters. Unknown categories are deliberately
  // not rejected: the generic evaluator below can enforce declarative parameters,
  // while unsupported free-form rules remain visible in diagnostics instead of
  // making the solver dataset-specific.
  const constraintApplies = (c: AnyRecord, r: AnyRecord) => {
    // Explicit entity targets are always respected, even if a stale/imported record
    // still says "school". This prevents a targeted rule from accidentally becoming a
    // school-wide restriction after edits, imports, or schema migrations.
    const targetsTeacher = Array.isArray(c.teacherIds) && c.teacherIds.length > 0;
    const targetsClass = Array.isArray(c.classIds) && c.classIds.length > 0;
    const targetsSubject = Array.isArray(c.subjectIds) && c.subjectIds.length > 0;
    if (targetsTeacher || targetsClass || targetsSubject) {
      return (!targetsTeacher || c.teacherIds.includes(r.teacherId))
        && (!targetsClass || c.classIds.includes(r.classId))
        && (!targetsSubject || c.subjectIds.includes(r.subjectId));
    }
    if (c.scope === 'school' || !c.scope) return true;
    if (c.scope === 'teachers') return !Array.isArray(c.teacherIds) || c.teacherIds.includes(r.teacherId);
    if (c.scope === 'classes') return !Array.isArray(c.classIds) || c.classIds.includes(r.classId);
    if (c.scope === 'subjects') return !Array.isArray(c.subjectIds) || c.subjectIds.includes(r.subjectId);
    return true;
  };
  const ruleParameters = (c: AnyRecord) => c.parameters && typeof c.parameters === 'object' ? c.parameters : {};
  const numericList = (value: any): number[] => Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : [];
  const genericConstraintBlocks = (c: AnyRecord, r: AnyRecord, cand: Candidate) => {
    if (!constraintApplies(c, r)) return false;
    const p = ruleParameters(c);
    const dayName = DAYS[cand.day];
    const unavailableDays = Array.isArray(p.unavailableDays) ? p.unavailableDays.map(String) : [];
    const unavailablePeriods = numericList(p.unavailablePeriods);
    if (unavailableDays.includes(dayName)) return true;
    if (unavailablePeriods.some(o => cand.orders.includes(o))) return true;
    if (p.earliestPeriod != null && cand.orders.some(o => o < Number(p.earliestPeriod))) return true;
    if (p.latestPeriod != null && cand.orders.some(o => o > Number(p.latestPeriod))) return true;
    if (Array.isArray(p.forbiddenDays) && p.forbiddenDays.map(String).includes(dayName)) return true;
    if (Array.isArray(p.allowedDays) && p.allowedDays.length && !p.allowedDays.map(String).includes(dayName)) return true;
    if (Array.isArray(p.forbiddenPeriods) && numericList(p.forbiddenPeriods).some(o => cand.orders.includes(o))) return true;
    if (Array.isArray(p.allowedPeriods) && numericList(p.allowedPeriods).length && !cand.orders.every(o => numericList(p.allowedPeriods).includes(o))) return true;
    return false;
  };
  const reqByPair = (classId: string, subjectId: string) => activeReqs.filter((r: AnyRecord) => r.classId === classId && r.subjectId === subjectId);
  const reqGroups: AnyRecord[][] = [];
  const consumed = new Set<string>();
  enabledRules.forEach((rule: AnyRecord) => {
    if (!Array.isArray(rule.pairs) || rule.pairs.length < 2) { addBlocker('Parallel rule "' + rule.name + '" needs at least two class/subject pairs.'); return; }
    const lists = rule.pairs.map((p: AnyRecord) => reqByPair(p.classId, p.subjectId));
    if (lists.some((a: AnyRecord[]) => a.length !== 1)) { addBlocker('Parallel rule "' + rule.name + '" must resolve each pair to exactly one active Weekly Requirement.'); return; }
    const reqs = lists.map((a: AnyRecord[]) => a[0]);
    if (unique(reqs.map((r: AnyRecord) => Number(r.lessonsPerWeek))).length !== 1) { addBlocker('Parallel rule "' + rule.name + '" has unequal weekly lesson counts.'); return; }
    reqs.forEach((r: AnyRecord) => consumed.add(r.id));
    reqGroups.push(reqs);
  });
  const divisionSyncGroups = new Map<string, AnyRecord[]>();
  activeReqs.filter((r: AnyRecord) => r.divisionSyncGroupId).forEach((r: AnyRecord) => { const group = divisionSyncGroups.get(r.divisionSyncGroupId) || []; group.push(r); divisionSyncGroups.set(r.divisionSyncGroupId, group); });
  const divisionCrossGroups: { syncId: string; sharedReqs: AnyRecord[]; continuingReqs: AnyRecord[] }[] = [];
  divisionSyncGroups.forEach((reqs, syncId) => {
    if (reqs.length < 2 || unique(reqs.map((r: AnyRecord) => Number(r.lessonsPerWeek))).length !== 1) {
      addBlocker('Division synchronization set ' + syncId + ' cannot be matched to equal shared lesson counts. Review its member configuration.');
      return;
    }
    const continuingReqs = reqs.map((r: AnyRecord) => r.crossDoublePairId ? activeReqs.find((x: AnyRecord) => x.crossDoublePairId === r.crossDoublePairId && x.crossDoublePart === 2) : null).filter(Boolean) as AnyRecord[];
    reqs.forEach((r: AnyRecord) => consumed.add(r.id));
    continuingReqs.forEach((r: AnyRecord) => consumed.add(r.id));
    if (continuingReqs.length) divisionCrossGroups.push({ syncId, sharedReqs: reqs, continuingReqs });
    else reqGroups.push(reqs);
  });
  const combined = (data.combined || []).filter((x: AnyRecord) => x.status === 'Active');
  combined.forEach((g: AnyRecord) => {
    const reqs = activeReqs.filter((r: AnyRecord) => r.combinedGroupId === g.id);
    const schedules = unique(reqs.map((r: AnyRecord) => getClass(r.classId)?.scheduleId).filter(Boolean));
    if (reqs.length !== g.classIds.length || reqs.some((r: AnyRecord) => r.subjectId !== g.subjectId || r.teacherId !== g.teacherId) || unique(reqs.map((r: AnyRecord) => Number(r.lessonsPerWeek))).length > 1) addBlocker('Combined group "' + g.name + '" has missing, mismatched, or unequal linked requirements.');
    else if (schedules.length !== 1) addBlocker('Combined group "' + g.name + '" contains classes on different bell schedules. Combined classes must use the same bell schedule so every participant occupies the same actual teaching interval.');
    else { reqs.forEach((r: AnyRecord) => consumed.add(r.id)); reqGroups.push(reqs); }
  });
  const units: Unit[] = [];
  const addUnits = (reqs: AnyRecord[], key: string) => {
    const n = Number(reqs[0].lessonsPerWeek);
    const patterns = reqs.map((r: AnyRecord) => r.lessonPattern || 'Doubles allowed');
    const configuredCounts = reqs.map((r: AnyRecord) => Number(r.doubleLessonsPerWeek ?? (r.lessonPattern === 'Double required' ? Math.floor(Number(r.lessonsPerWeek || 0) / 2) : 0)));
    const sameDivisionSyncSet = reqs.length > 1 && reqs.every((r: AnyRecord) => Boolean(r.divisionSyncGroupId) && r.divisionSyncGroupId === reqs[0].divisionSyncGroupId);
    const hasDifferentBlockRules = reqs.length > 1 && reqs.some((r: AnyRecord, index: number) => configuredCounts[index] !== configuredCounts[0] || (r.lessonPattern || 'Single lessons only') !== (reqs[0].lessonPattern || 'Single lessons only'));
    // Different lesson-block rules do not break division synchronization. For
    // members of the same shared set, each actual shared period remains a joint
    // unit; only the member configured for a double treats the two periods as
    // one event. Other linked use cases retain their independent block handling.
    if (hasDifferentBlockRules && !sameDivisionSyncSet) {
      reqs.forEach((r: AnyRecord) => addUnits([r], key + ':member:' + String(r.id)));
      return;
    }
    const maxDoubleCount = Math.max(0, ...configuredCounts);
    if (configuredCounts.some((count, index) => !Number.isInteger(count) || count < 0 || count > Math.floor(Number(reqs[index].lessonsPerWeek || 0) / 2))) { addBlocker('Double lesson count is invalid for ' + reqs.map((r: AnyRecord) => getClass(r.classId)?.name + ' ' + getSubject(r.subjectId)?.name).join(', ') + '.'); return; }
    if (configuredCounts.some((count, index) => count > 0 && !getSubject(reqs[index].subjectId)?.acceptsDoubleLesson)) { addBlocker('A linked requirement requests double lessons for a subject that does not allow them.'); return; }
    if (patterns.some((p: string, index: number) => p === 'Double required' && configuredCounts[index] === 0 && reqs[index].doubleLessonsPerWeek == null)) { addBlocker('A required-double pattern needs at least one double lesson. Set its weekly double count.'); return; }
    // Synchronize the actual time slots without forcing linked members to share a lesson-block format.
    // A member configured for a double uses both periods as one event; a single-only member
    // receives two separate single placements in those same periods.
    for (let i = 0; i < maxDoubleCount; i += 1) {
      const doubleReqIds = reqs.filter((r: AnyRecord, index: number) => configuredCounts[index] > i).map((r: AnyRecord) => String(r.id));
      units.push({
        key: key + ':linked-block:' + i, reqs, ordinal: i * 2, duration: 2,
        slotReqs: [reqs, reqs], doubleReqIds, lessonBlockType: 'Double', doublePart: 1,
        label: reqs.map((r: AnyRecord) => (getClass(r.classId)?.name || 'Class') + ' · ' + (getSubject(r.subjectId)?.name || 'Subject')).join(' + ')
      });
    }
    for (let i = 0; i < n - maxDoubleCount * 2; i += 1) {
      const ordinal = maxDoubleCount * 2 + i;
      const crossFirst = reqs.some((r: AnyRecord) => r.crossDoublePart === 1);
      const crossSecond = reqs.some((r: AnyRecord) => r.crossDoublePart === 2);
      const adjacencyKey = crossFirst || crossSecond ? String(reqs.find((r: AnyRecord) => r.crossDoublePairId)?.crossDoublePairId || '') : '';
      const isBoundaryPart = Boolean(adjacencyKey) && ((crossFirst && i === n - maxDoubleCount * 2 - 1) || (crossSecond && i === 0));
      units.push({ key: key + ':single:' + i, reqs, ordinal, duration: 1, lessonBlockType: isBoundaryPart ? 'Double' : 'Single', doublePart: isBoundaryPart ? (crossFirst ? 1 : 2) : undefined, label: reqs.map((r: AnyRecord) => (getClass(r.classId)?.name || 'Class') + ' · ' + (getSubject(r.subjectId)?.name || 'Subject')).join(' + '), ...(isBoundaryPart ? { adjacencyKey, adjacencyPart: (crossFirst ? 1 : 2) as 1 | 2 } : {}) });
    }
  };
  divisionCrossGroups.forEach(group => {
    const reqs = [...group.sharedReqs, ...group.continuingReqs];
    units.push({
      key: 'division-cross-double:' + group.syncId,
      reqs,
      slotReqs: [group.sharedReqs, group.continuingReqs],
      ordinal: 0,
      duration: 2,
      lessonBlockType: 'Double',
      label: reqs.map((r: AnyRecord) => (getClass(r.classId)?.name || 'Class') + ' · ' + (getSubject(r.subjectId)?.name || 'Subject')).join(' + ')
    });
    const sharedRemainder = group.sharedReqs
      .map((r: AnyRecord) => ({ ...r, lessonsPerWeek: Math.max(0, Number(r.lessonsPerWeek) - 1), crossDoublePairId: '', crossDoublePart: undefined }))
      .filter((r: AnyRecord) => Number(r.lessonsPerWeek) > 0);
    // The first slot of the cross-boundary double consumes one shared lesson for
    // every linked member. The remaining shared lessons must stay synchronized,
    // so they are rebuilt as one linked unit rather than one independent unit per
    // member. This remains entirely data-driven and works for any division size.
    if (sharedRemainder.length > 1) addUnits(sharedRemainder, 'division-shared-remainder:' + group.syncId);
    else if (sharedRemainder.length === 1) addUnits(sharedRemainder, 'division-shared-remainder:' + group.syncId);
    group.continuingReqs.forEach((r: AnyRecord, index: number) => {
      const remaining = Math.max(0, Number(r.lessonsPerWeek) - 1);
      if (remaining > 0) addUnits([{ ...r, lessonsPerWeek: remaining, crossDoublePairId: '', crossDoublePart: undefined }], 'division-independent-remainder:' + group.syncId + ':' + index);
    });
  });
  reqGroups.forEach((g, i) => { if (g.every((r: AnyRecord) => !units.some(u => u.reqs.includes(r)))) addUnits(g, 'linked-' + i); });
  activeReqs.filter((r: AnyRecord) => !consumed.has(r.id)).forEach((r: AnyRecord) => addUnits([r], r.id));
  if (violations.length) return { status: 'Blocked', placements: [], scheduledPeriods: 0, unscheduled: activeReqs.map((r: AnyRecord) => ({ requirementId: r.id, label: (getClass(r.classId)?.name || 'Class') + ' · ' + (getSubject(r.subjectId)?.name || 'Subject'), reason: 'Resolve the generation blocker above first.' })), violations, softScore: 0, exploredNodes: 0, message: 'Generation was blocked before search. Fix the listed data/rule issues and retry.' };
  const periodsFor = (r: AnyRecord) => {
    const c = getClass(r.classId);
    return (data.periods || []).filter((p: AnyRecord) => p.scheduleId === c?.scheduleId && p.status === 'Active' && p.type === 'Lesson').sort((a: AnyRecord, b: AnyRecord) => Number(a.order) - Number(b.order));
  };
  const candidates = (u: Unit): Candidate[] => {
    const base = periodsFor(u.reqs[0]);
    const out: Candidate[] = [];
    for (let day = 0; day < days; day++) for (const first of base) {
      const seq = [first];
      if (u.duration === 2) {
        const sorted = base;
        const idx = sorted.findIndex((p: AnyRecord) => p.id === first.id);
        const next = sorted[idx + 1];
        if (!next || Number(next.order) !== Number(first.order) + 1 || mins(first.end) !== mins(next.start)) continue;
        seq.push(next);
      }
      // A duration-based event always occupies one requirement set per actual
      // teaching period. For ordinary singles/doubles there is no explicit
      // slotReqs map, so derive it from the event duration rather than the
      // number of linked requirements. This is critical for combined events
      // with 3+ requirements: their requirement count must never create more
      // slots than the event actually occupies.
      const slotReqs = u.slotReqs || Array.from({ length: u.duration }, () => u.reqs);
      const matchedPeriods = slotReqs.map((slotReqsForPeriod: AnyRecord[], slotIndex: number) => slotReqsForPeriod.map((r: AnyRecord) => periodsFor(r).find((x: AnyRecord) => Number(x.order) === Number(seq[slotIndex].order) && x.type === 'Lesson')));
      if (matchedPeriods.some((slotPeriods: AnyRecord[]) => slotPeriods.some(p => !p))) continue;
      const referencePeriods = matchedPeriods.map(slot => slot[0]);
      if (referencePeriods.some((p: AnyRecord) => !p)) continue;
      if (referencePeriods.some((p: AnyRecord, i: number) => i > 0 && (mins(referencePeriods[i - 1].end) !== mins(p.start) || Number(p.order) !== Number(referencePeriods[i - 1].order) + 1))) continue;
      if (slotReqs.some((slot: AnyRecord[], slotIndex: number) => slot.some((r: AnyRecord) => periodsFor(r).find((x: AnyRecord) => Number(x.order) === Number(seq[slotIndex].order) && x.type === 'Lesson') === undefined))) continue;
      // Linked requirements can share the same bell schedule. Keep one reference per actual period so a shared event does not double-count periods for each requirement.
      const allPeriods = unique(matchedPeriods.flat() as AnyRecord[]);
      const rooms: string[] = [];
      let invalid = false;
      for (const r of u.reqs) {
        const c = getClass(r.classId), s = getSubject(r.subjectId);
        let roomId = '';
        const reqSlotCount = u.doubleReqIds ? (u.doubleReqIds.includes(String(r.id)) ? 2 : 1) : (u.slotReqs ? u.slotReqs.filter(slot => slot.some(q => q.id === r.id)).length : u.duration);
        const doubleRoom = reqSlotCount === 2 ? s?.doubleLessonRoomId : '';
        if (doubleRoom === '__HOME_ROOM__' || r.useHomeRoom) roomId = c?.homeRoomId || '';
        else if (doubleRoom) roomId = doubleRoom;
        else if (r.roomRequirement === 'Required room') roomId = r.preferredRoomId || '';
        else if (r.roomRequirement === 'Preferred room') roomId = r.preferredRoomId || c?.homeRoomId || '';
        else if (r.roomRequirement === 'Room type') roomId = activeRooms.find((x: AnyRecord) => x.roomType === r.requiredRoomType)?.id || '';
        else if (r.roomRequirement === 'Room capability') roomId = activeRooms.find((x: AnyRecord) => x.capabilities?.some((v: string) => v.toLowerCase() === s?.name.toLowerCase()))?.id || '';
        else roomId = c?.homeRoomId || '';
        if (roomId && !activeRooms.some((x: AnyRecord) => x.id === roomId)) invalid = true;
        if ((r.useHomeRoom || doubleRoom === '__HOME_ROOM__') && !roomId) invalid = true;
        if ((r.roomRequirement === 'Required room' || r.roomRequirement === 'Room type' || r.roomRequirement === 'Room capability') && !roomId) invalid = true;
        rooms.push(roomId);
      }
      if (invalid) continue;
      let score = 0;
      enabledConstraints.filter((c: AnyRecord) => c.category === 'Subject placement').forEach((c: AnyRecord) => { const p = c.parameters || {}; if ((p.preferredDays || []).includes(DAYS[day])) score += Number(c.weight || 1); });
      out.push({ day, orders: seq.map((p: AnyRecord) => Number(p.order)), periods: allPeriods, rooms, score, tieBreak: Math.random() });
    }
    return out.sort((a, b) => b.score - a.score || b.tieBreak - a.tieBreak || a.day - b.day || a.orders[0] - b.orders[0]);
  };
  const unitCandidates = new Map(units.map(u => [u.key, candidates(u)]));
  const empty = units.filter(u => !(unitCandidates.get(u.key) || []).length);
  if (empty.length) return { status: 'Blocked', placements: [], scheduledPeriods: 0, unscheduled: empty.map(u => ({ requirementId: u.reqs[0].id, label: u.label, reason: 'No valid teaching-period placement exists for this lesson pattern and bell schedule.' })), violations: ['One or more events have no valid period candidates.'], softScore: 0, exploredNodes: 0, message: 'Generation is blocked because one or more events cannot fit the configured periods.' };
  const placed: { unit: Unit; candidate: Candidate }[] = [];
  let best: { unit: Unit; candidate: Candidate }[] = [];
  let nodes = 0, limitReached = false, foundComplete = false;
  // Reserve part of the existing bounded budget for conflict-directed finishing.
  // The main DFS must not consume all available time/nodes before repair can run.
  const searchStartedAt = Date.now();
  const totalTimeMs = deepSearch ? 15000 : 8000;
  const searchDeadline = searchStartedAt + Math.floor(totalTimeMs * 0.72);
  const deadline = searchStartedAt + totalTimeMs;
  const searchNodeBudget = Math.max(1, Math.floor(budget * 0.85));
  // Search runs in the browser, so periodically yield to the event loop instead of holding
  // the main thread for the entire bounded search. This keeps the page interactive while
  // preserving the same deterministic search budget.
  const yieldToBrowser = () => new Promise<void>(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
  let yieldCounter = 0;
  const scopeMatches = (c: AnyRecord, r: AnyRecord) => c.scope === 'school' || (c.scope === 'teachers' && c.teacherIds?.includes(r.teacherId)) || (c.scope === 'classes' && c.classIds?.includes(r.classId)) || (c.scope === 'subjects' && c.subjectIds?.includes(r.subjectId));
  const softConstraints = (constraints || []).filter((c: AnyRecord) => c.enabled && c.classification === 'Soft');
  const candidateScore = (u: Unit, cand: Candidate): number => {
    let score = cand.score;
    for (const r of u.reqs) {
      const subject = getSubject(r.subjectId);
      const sameClassSubjectToday = placed.filter(x => x.candidate.day === cand.day && x.unit.reqs.some((q: AnyRecord) => q.classId === r.classId && q.subjectId === r.subjectId)).length;
      const sameClassToday = placed.filter(x => x.candidate.day === cand.day && x.unit.reqs.some((q: AnyRecord) => q.classId === r.classId)).length;
      const sameClassSubjectPeriod = placed.filter(x => x.unit.reqs.some((q: AnyRecord) => q.classId === r.classId && q.subjectId === r.subjectId) && x.candidate.orders.some(o => cand.orders.includes(o))).length;
      // Prefer spreading a subject across the week and avoid unnecessary same-day repetition.
      score -= sameClassSubjectToday * 8;
      // Avoid symmetry: unless a rule requires otherwise, repeated weekly lessons of the same
      // class/subject should not keep landing in the same period number every day.
      score -= sameClassSubjectPeriod * 14;
      score -= Math.max(0, sameClassToday - 3) * 2;
      const alreadyOnDay = placed.some(x => x.candidate.day === cand.day && x.unit.reqs.some((q: AnyRecord) => q.classId === r.classId && q.subjectId === r.subjectId));
      if (alreadyOnDay && Number(r.lessonsPerWeek) <= days) score -= 10;
      if (subject?.acceptsDoubleLesson && u.duration === 2) score += 2;
      for (const rule of softConstraints) {
        if (!constraintApplies(rule, r)) continue;
        const p = rule.parameters || {};
        const weight = Math.max(1, Math.min(100, Number(rule.weight) || 1));
        if (rule.category === 'Teacher availability' && Array.isArray(p.preferredPeriods) && cand.orders.some(o => p.preferredPeriods.includes(o))) score += weight;
        if (rule.category === 'Subject placement') {
          if (Array.isArray(p.preferredDays) && p.preferredDays.includes(DAYS[cand.day])) score += weight;
          if (cand.orders.some(o => o < Number(p.earliestPeriod || 1) || o > Number(p.latestPeriod || 99))) score -= weight * 2;
          if (p.maxLessonsPerDay && sameClassSubjectToday >= Number(p.maxLessonsPerDay)) score -= weight * 3;
        }
        if (rule.category === 'Subject frequency') {
          if (p.distributionPreference === 'spread-across-week' && alreadyOnDay) score -= weight;
          if (p.distributionPreference === 'balanced' && sameClassToday > 3) score -= weight;
        }
        if (rule.category === 'Teacher consecutive single lessons' && p.preventConsecutiveSingleLessons && u.duration === 1 && !p.applyToDoubleLessons) {
          const adjacent = placed.some(x => x.unit.reqs.some((q: AnyRecord) => q.teacherId === r.teacherId) && x.candidate.day === cand.day && x.unit.duration === 1 && x.candidate.orders.some(o => cand.orders.some(n => Math.abs(n - o) === 1)));
          if (adjacent) score -= weight * 2;
        }
      }
      // A small tie-breaker favors candidates that reduce same-day clustering.
      score -= sameClassSubjectToday * 2;
    }
    return score;
  };
    const placedByClass = new Map<string, { unit: Unit; candidate: Candidate }[]>();
  const placedByTeacher = new Map<string, { unit: Unit; candidate: Candidate }[]>();
  const placedByRoom = new Map<string, { unit: Unit; candidate: Candidate }[]>();
  let candidateChecks = 0;
  let conflictChecks = 0;
  let prunedBranches = 0;
  const reqPeriods = (r: AnyRecord, cand: Candidate, unit: Unit) => unit.slotReqs ? cand.periods.filter((_, index) => (unit.slotReqs?.[index] || []).some((q: AnyRecord) => q.id === r.id)) : cand.periods.filter((p: AnyRecord) => p.scheduleId === getClass(r.classId)?.scheduleId);
  const eventOverlaps = (a: AnyRecord[], b: AnyRecord[]) => a.some((p: AnyRecord) => b.some((q: AnyRecord) => overlaps(p, q)));
  const sameDivisionStudentGroups = (a: AnyRecord, b: AnyRecord) => Boolean(a.divisionId && b.divisionId && a.studentGroupId && b.studentGroupId && a.studentGroupId !== b.studentGroupId);
  const addPlacedIndex = (entry: { unit: Unit; candidate: Candidate }) => {
    for (const r of entry.unit.reqs) {
      const byClass = placedByClass.get(r.classId) || []; byClass.push(entry); placedByClass.set(r.classId, byClass);
      const byTeacher = placedByTeacher.get(r.teacherId) || []; byTeacher.push(entry); placedByTeacher.set(r.teacherId, byTeacher);
      const roomId = entry.candidate.rooms[entry.unit.reqs.indexOf(r)] || ''; if (roomId) { const byRoom = placedByRoom.get(roomId) || []; byRoom.push(entry); placedByRoom.set(roomId, byRoom); }
    }
  };
  const removePlacedIndex = (entry: { unit: Unit; candidate: Candidate }) => {
    for (const r of entry.unit.reqs) {
      placedByClass.set(r.classId, (placedByClass.get(r.classId) || []).filter(x => x !== entry));
      placedByTeacher.set(r.teacherId, (placedByTeacher.get(r.teacherId) || []).filter(x => x !== entry));
      const roomId = entry.candidate.rooms[entry.unit.reqs.indexOf(r)] || ''; if (roomId) placedByRoom.set(roomId, (placedByRoom.get(roomId) || []).filter(x => x !== entry));
    }
  };
  type PlacementEntry = { unit: Unit; candidate: Candidate };
  const findBlockingEntries = (u: Unit, cand: Candidate): Set<PlacementEntry> => {
    const blockers = new Set<PlacementEntry>();
    for (let i = 0; i < u.reqs.length; i++) {
      const a = u.reqs[i];
      const aPs = reqPeriods(a, cand, u);
      for (const prev of placedByClass.get(a.classId) || []) {
        for (const b of prev.unit.reqs) {
          const bPs = reqPeriods(b, prev.candidate, prev.unit);
          if (cand.day !== prev.candidate.day || !eventOverlaps(aPs, bPs)) continue;
          const separateDivisionGroups = sameDivisionStudentGroups(a, b);
          const division = separateDivisionGroups ? (data.divisions || []).find((d: AnyRecord) => d.id === a.divisionId || d.id === b.divisionId) : null;
          const partialDoubleSingle = Boolean(separateDivisionGroups && u.duration !== prev.unit.duration && (u.duration === 2 || prev.unit.duration === 2));
          if (!separateDivisionGroups || (partialDoubleSingle && !division?.allowPartialOverlap)) blockers.add(prev);
        }
      }
      for (const prev of placedByTeacher.get(a.teacherId) || []) {
        for (const b of prev.unit.reqs) {
          const bPs = reqPeriods(b, prev.candidate, prev.unit);
          if (cand.day === prev.candidate.day && eventOverlaps(aPs, bPs)) blockers.add(prev);
        }
      }
      const roomId = cand.rooms[i] || '';
      if (roomId) for (const prev of placedByRoom.get(roomId) || []) {
        for (const b of prev.unit.reqs) {
          const bIndex = prev.unit.reqs.indexOf(b);
          if ((prev.candidate.rooms[bIndex] || '') !== roomId) continue;
          const bPs = reqPeriods(b, prev.candidate, prev.unit);
          if (cand.day === prev.candidate.day && eventOverlaps(aPs, bPs)) blockers.add(prev);
        }
      }
    }
    return blockers;
  };
  const consecutiveSingleLimitBlocks = (r: AnyRecord, cand: Candidate) => {
    const rules = enabledConstraints.filter((c: AnyRecord) => c.category === 'Teacher consecutive single lessons' && constraintApplies(c, r));
    for (const rule of rules) {
      const p = ruleParameters(rule);
      if (p.preventConsecutiveSingleLessons === false || cand.orders.length !== 1) continue;
      const maxOverall = Math.max(1, Number(p.maxConsecutiveSingleLessons ?? 1));
      const maxSameClass = Math.max(1, Number(p.maxConsecutiveSameClassSingleLessons ?? 1));
      const teacherEntries = placedByTeacher.get(r.teacherId) || [];
      const orderClass = new Map<number, string>();
      teacherEntries.forEach(entry => {
        if (entry.unit.duration !== 1 || entry.candidate.day !== cand.day) return;
        entry.unit.reqs.forEach(q => {
          if (q.teacherId !== r.teacherId) return;
          entry.candidate.orders.forEach(order => orderClass.set(Number(order), q.classId));
        });
      });
      orderClass.set(Number(cand.orders[0]), r.classId);
      const ordered = [...orderClass.keys()].sort((a, b) => a - b);
      let overallRun = 0;
      let sameClassRun = 0;
      let previous = -Infinity;
      let previousClass = '';
      for (const order of ordered) {
        const currentClass = orderClass.get(order) || '';
        if (order === previous + 1) overallRun += 1; else overallRun = 1;
        if (order === previous + 1 && currentClass === previousClass) sameClassRun += 1; else sameClassRun = 1;
        if (overallRun > maxOverall || sameClassRun > maxSameClass) return true;
        previous = order;
        previousClass = currentClass;
      }
    }
    return false;
  };
  const conflicts = (u: Unit, cand: Candidate) => {
    candidateChecks += 1;
    if (u.adjacencyKey && u.adjacencyPart) {
      const partner = placed.find(entry => entry.unit.adjacencyKey === u.adjacencyKey && entry.unit.adjacencyPart !== u.adjacencyPart);
      if (partner) {
        const thisOrder = Number(cand.orders[0]);
        const partnerOrder = Number(partner.candidate.orders[0]);
        const adjacentCorrectly = cand.day === partner.candidate.day && (u.adjacencyPart === 1 ? partnerOrder === thisOrder + 1 : thisOrder === partnerOrder + 1);
        if (!adjacentCorrectly) return true;
      }
    }
    for (let i = 0; i < u.reqs.length; i++) {
      const a = u.reqs[i];
      const aPs = reqPeriods(a, cand, u);
      for (const prev of placedByClass.get(a.classId) || []) {
        conflictChecks += 1;
        for (const b of prev.unit.reqs) {
          const bPs = reqPeriods(b, prev.candidate, prev.unit);
          if (cand.day !== prev.candidate.day || !eventOverlaps(aPs, bPs)) continue;
          const separateDivisionGroups = sameDivisionStudentGroups(a, b);
          const division = separateDivisionGroups ? (data.divisions || []).find((d: AnyRecord) => d.id === a.divisionId || d.id === b.divisionId) : null;
          const partialDoubleSingle = Boolean(separateDivisionGroups && u.duration !== prev.unit.duration && (u.duration === 2 || prev.unit.duration === 2));
          // A cross-boundary division double is a deliberate exception to the
          // general partial-double overlap setting: its first period is shared
          // with the synchronized single-lesson set, while its second period
          // belongs only to the member continuing the double. Permit overlap
          // only when both members are explicitly in that unit's first shared
          // slot and have the same configured synchronization-group ID.
          const sharesCrossBoundaryFirstSlot = (longUnit: Unit, shortReq: AnyRecord, longReq: AnyRecord) =>
            longUnit.duration === 2 &&
            Boolean(longUnit.slotReqs?.[0]?.some((q: AnyRecord) => q.id === shortReq.id)) &&
            Boolean(longUnit.slotReqs?.[0]?.some((q: AnyRecord) => q.id === longReq.id)) &&
            Boolean(shortReq.divisionSyncGroupId) &&
            shortReq.divisionSyncGroupId === longReq.divisionSyncGroupId;
          const crossBoundarySharedOverlap = Boolean(
            partialDoubleSingle &&
            a.id !== b.id &&
            a.divisionSyncGroupId &&
            a.divisionSyncGroupId === b.divisionSyncGroupId &&
            ((u.duration === 2 && sharesCrossBoundaryFirstSlot(u, a, b)) ||
             (prev.unit.duration === 2 && sharesCrossBoundaryFirstSlot(prev.unit, a, b)))
          );
          if (!separateDivisionGroups || (partialDoubleSingle && !division?.allowPartialOverlap && !crossBoundarySharedOverlap)) return true;
        }
      }
      for (const prev of placedByTeacher.get(a.teacherId) || []) {
        conflictChecks += 1;
        for (const b of prev.unit.reqs) {
          const bPs = reqPeriods(b, prev.candidate, prev.unit);
          if (cand.day === prev.candidate.day && eventOverlaps(aPs, bPs)) return true;
        }
      }
      const roomId = cand.rooms[i] || '';
      if (roomId) for (const prev of placedByRoom.get(roomId) || []) {
        conflictChecks += 1;
        for (const b of prev.unit.reqs) {
          const bIndex = prev.unit.reqs.indexOf(b);
          if ((prev.candidate.rooms[bIndex] || '') !== roomId) continue;
          const bPs = reqPeriods(b, prev.candidate, prev.unit);
          if (cand.day === prev.candidate.day && eventOverlaps(aPs, bPs)) return true;
        }
      }
    }
    for (const c of enabledConstraints) for (const r of u.reqs) {
      if (genericConstraintBlocks(c, r, cand)) return true;
      if (!constraintApplies(c, r)) continue;
      const p = ruleParameters(c);
      if (p.maxLessonsPerDay) {
        const count = placedByClass.get(r.classId)?.filter(x => x.unit.reqs.some((z: AnyRecord) => z.subjectId === r.subjectId) && x.candidate.day === cand.day).length || 0;
        if (count >= Number(p.maxLessonsPerDay)) return true;
      }
      if (p.minLessonsPerDay && Number(p.minLessonsPerDay) > 0) {
        // This is enforced as a post-placement feasibility signal rather than by
        // inventing a category-specific rule: candidates can still be explored,
        // while validation reports unmet minimums when the final timetable is built.
      }
      if (p.preventConsecutiveSingleLessons && u.duration === 1 && p.applyToDoubleLessons !== true) {
        // The configurable consecutive-single evaluator below decides whether an adjacent
        // run is valid. This branch only remains for legacy rules that explicitly omit the
        // new limits; it preserves the historical one-consecutive-single default.
        const hasNewLimits = p.maxConsecutiveSingleLessons != null || p.maxConsecutiveSameClassSingleLessons != null;
        if (!hasNewLimits) {
          const adjacent = (placedByTeacher.get(r.teacherId) || []).some(x => x.unit.duration === 1 && x.candidate.day === cand.day && x.candidate.orders.some(o => cand.orders.some(n => Math.abs(n - o) === 1)));
          if (adjacent) return true;
        }
      }
    }
    if (u.duration === 1 && u.reqs.some((r: AnyRecord) => consecutiveSingleLimitBlocks(r, cand))) return true;
    return false;
  };
  let bestScore = -Infinity;
  let bestScheduledPeriods = -1;
  let currentScore = 0;
  let currentScheduledPeriods = 0;
  const recurse = async (remaining: Unit[]): Promise<boolean> => {
    if (++yieldCounter >= 32) {
      yieldCounter = 0;
      await yieldToBrowser();
    }
    if (nodes >= searchNodeBudget || Date.now() >= searchDeadline) { limitReached = true; return false; }
    // Retain the partial candidate that covers the most actual requirement-periods.
    if (currentScheduledPeriods > bestScheduledPeriods || (currentScheduledPeriods === bestScheduledPeriods && currentScore > bestScore)) {
      best = placed.slice();
      bestScore = currentScore;
      bestScheduledPeriods = currentScheduledPeriods;
    }
    if (remaining.length === 0) { if (placed.length === units.length) { foundComplete = true; if (!deepSearch) return true; } return false; }
    if (currentScheduledPeriods + remaining.reduce((sum, u) => sum + (u.slotReqs ? u.slotReqs.reduce((n, slot) => n + slot.length, 0) : u.reqs.length * u.duration), 0) < bestScheduledPeriods) { prunedBranches += 1; return false; }
    nodes++;
    let nextUnit: Unit | null = null;
    let nextCandidates: Candidate[] = [];
    // Dynamic MRV: re-check every remaining event after each placement and branch on
    // the most constrained event that still has a legal candidate. A single event with
    // zero viable candidates must not abort the entire school timetable: defer that event
    // for this branch and continue scheduling other feasible events. It remains unscheduled
    // and prevents Complete status unless a later branch can place every event.
    const blockedKeys = new Set<string>();
    for (const candidateUnit of remaining) {
      const viable = (unitCandidates.get(candidateUnit.key) || []).filter(candidate => !conflicts(candidateUnit, candidate));
      if (viable.length === 0) {
        blockedKeys.add(candidateUnit.key);
        prunedBranches += 1;
        continue;
      }
      if (nextUnit === null || viable.length < nextCandidates.length || (viable.length === nextCandidates.length && (candidateUnit.duration > nextUnit.duration || (candidateUnit.duration === nextUnit.duration && candidateUnit.key.localeCompare(nextUnit.key) < 0)))) {
        nextUnit = candidateUnit;
        nextCandidates = viable;
      }
    }
    if (!nextUnit) { prunedBranches += 1; return false; }
    // Remove currently blocked events from this branch's immediate recursion only.
    // Their missing lessons are still reflected in best coverage, unscheduled output,
    // and the complete-solution guard (placed.length === units.length).
    const rest = remaining.filter(unit => unit.key !== nextUnit!.key && !blockedKeys.has(unit.key));
    nextCandidates = nextCandidates.map(candidate => ({ ...candidate, score: candidateScore(nextUnit!, candidate) }));
    nextCandidates.sort((a, b) => b.score - a.score || b.tieBreak - a.tieBreak || a.day - b.day || a.orders[0] - b.orders[0]);
    for (const candidate of nextCandidates) {
      const entry = { unit: nextUnit, candidate };
      placed.push(entry);
      addPlacedIndex(entry);
      currentScore += candidate.score;
      currentScheduledPeriods += nextUnit.slotReqs ? nextUnit.slotReqs.reduce((n, slot) => n + slot.length, 0) : nextUnit.reqs.length * nextUnit.duration;
      if (await recurse(rest)) return true;
      currentScheduledPeriods -= nextUnit.slotReqs ? nextUnit.slotReqs.reduce((n, slot) => n + slot.length, 0) : nextUnit.reqs.length * nextUnit.duration;
      currentScore -= candidate.score;
      removePlacedIndex(entry);
      placed.pop();
      if (limitReached) break;
    }
    return false;
  };
  units.sort((a, b) => (unitCandidates.get(a.key)?.length || 9999) - (unitCandidates.get(b.key)?.length || 9999) || b.duration - a.duration || a.key.localeCompare(b.key));
  const complete = await recurse(units);

  // The bounded DFS is intentionally finite. When it reaches a strong near-complete
  // candidate, use a small conflict-directed repair pass before giving up. This is
  // especially useful for dense timetables where only a handful of events remain:
  // move the missing event into a candidate slot, temporarily displace the few events
  // blocking that slot, then recursively re-place the displaced events. This changes
  // the search shape rather than merely increasing the runtime limit.
  let repairedBest = best.slice();
  // Repair is a bounded finishing step, not a second full solver. Never invoke it
  // for an empty/root-dead search result: that turns a useful feasibility failure
  // into an enormous recursive scan of the entire dataset.
  const repairCoverage = units.length ? best.length / units.length : 0;
  const repairEligible = !foundComplete && best.length > 0 && repairCoverage >= 0.6 && best.length < units.length && nodes < budget && Date.now() < deadline;
  if (repairEligible) {
    const repairPlaced = best.slice();
    placed.push(...repairPlaced);
    repairPlaced.forEach(addPlacedIndex);
    const repairMissing = units.filter(u => !repairPlaced.some(x => x.unit.key === u.key));
    const repair = async (remaining: Unit[], depth: number): Promise<boolean> => {
      if (++yieldCounter >= 16) {
        yieldCounter = 0;
        await yieldToBrowser();
      }
      if (!remaining.length) return true;
      if (depth > 4 || Date.now() >= deadline || nodes >= budget) return false;
      let target: Unit | null = null;
      let targetOptions: { candidate: Candidate; blockers: PlacementEntry[] }[] = [];
      for (const unit of remaining) {
        if (Date.now() >= deadline || nodes >= budget) return false;
        const options: { candidate: Candidate; blockers: PlacementEntry[] }[] = [];
        for (const candidate of unitCandidates.get(unit.key) || []) {
          if (Date.now() >= deadline || nodes >= budget) return false;
          const blockers = [...findBlockingEntries(unit, candidate)];
          if (!blockers.length) {
            if (!conflicts(unit, candidate)) options.push({ candidate, blockers: [] });
            continue;
          }
          blockers.forEach(removePlacedIndex);
          const stillBlocked = conflicts(unit, candidate);
          blockers.forEach(addPlacedIndex);
          if (!stillBlocked) options.push({ candidate, blockers });
        }
        if (!options.length) continue;
        options.sort((a, b) => a.blockers.length - b.blockers.length || b.candidate.score - a.candidate.score || a.candidate.day - b.candidate.day || a.candidate.orders[0] - b.candidate.orders[0]);
        if (!target || options.length < targetOptions.length || (options.length === targetOptions.length && options[0].blockers.length < targetOptions[0].blockers.length)) {
          target = unit;
          targetOptions = options;
        }
      }
      if (!target) return false;
      for (const option of targetOptions) {
        const displaced = option.blockers.slice();
        const displacedSet = new Set(displaced);
        // A blocker is being removed from the current solution, not merely from
        // the conflict indexes. Leaving it in `placed` causes the repair result
        // to contain both the old and replacement copy, which can make the grid
        // appear fully scheduled while requirement coverage still reports a
        // missing lesson. Remove the actual entries before re-placement.
        option.blockers.forEach(removePlacedIndex);
        for (let i = placed.length - 1; i >= 0; i -= 1) {
          if (displacedSet.has(placed[i])) placed.splice(i, 1);
        }
        const entry: PlacementEntry = { unit: target, candidate: option.candidate };
        placed.push(entry);
        addPlacedIndex(entry);
        const nextRemaining = remaining.filter(u => u.key !== target!.key);
        const displacedUnits = displaced.map(x => x.unit).filter((u, index, xs) => xs.findIndex(v => v.key === u.key) === index);
        const combinedRemaining = [...nextRemaining.filter(u => !displacedUnits.some(d => d.key === u.key)), ...displacedUnits];
        if (await repair(combinedRemaining, depth + 1)) return true;
        removePlacedIndex(entry);
        const entryIndex = placed.lastIndexOf(entry);
        if (entryIndex >= 0) placed.splice(entryIndex, 1);
        displaced.forEach(displacedEntry => {
          placed.push(displacedEntry);
          addPlacedIndex(displacedEntry);
        });
      }
      return false;
    };
    const repaired = await repair(repairMissing, 1);
    if (repaired) repairedBest = placed.slice();
    while (placed.length) {
      const entry = placed.pop()!;
      removePlacedIndex(entry);
    }
  }
  const chosen = repairedBest;
  chosen.forEach(({ unit, candidate }) => unit.reqs.forEach((r: AnyRecord, i: number) => {
    const ps = unit.slotReqs ? candidate.periods.filter((_, slotIndex) => (unit.slotReqs?.[slotIndex] || []).some((q: AnyRecord) => q.id === r.id)) : candidate.periods.filter((p: AnyRecord) => p.scheduleId === getClass(r.classId)?.scheduleId);
    if (!ps.length) return;
    const isCrossDoubleHalf = Boolean(r.crossDoublePairId && (r.crossDoublePart === 1 || r.crossDoublePart === 2));
    const isConfiguredDoubleMember = Boolean(unit.doubleReqIds?.includes(String(r.id)));
    const emit = (eventPeriods: AnyRecord[], isDoubleEvent: boolean) => placements.push({
      requirementId: r.id, classId: r.classId, subjectId: r.subjectId, teacherId: r.teacherId,
      roomId: candidate.rooms[i] || '', day: candidate.day,
      periodOrders: eventPeriods.map((p: AnyRecord) => Number(p.order)), periodIds: eventPeriods.map((p: AnyRecord) => p.id),
      divisionId: r.divisionId || undefined, divisionMemberId: r.divisionMemberId || undefined,
      studentGroupId: r.studentGroupId || undefined, divisionSyncGroupId: r.divisionSyncGroupId || undefined,
      combinedGroupId: r.combinedGroupId || undefined,
      divisionDoublePairId: r.crossDoublePairId || undefined,
      lessonBlockType: isDoubleEvent || isCrossDoubleHalf ? 'Double' : 'Single',
      doublePart: isCrossDoubleHalf ? r.crossDoublePart : (isDoubleEvent ? 1 : undefined)
    });
    if (unit.doubleReqIds) {
      if (isConfiguredDoubleMember) emit(ps, true);
      else ps.forEach(period => emit([period], false));
      return;
    }
    emit(ps, ps.length === 2 || isCrossDoubleHalf);
  }));
  const validator = validateSchedule(data, placements);
  activeReqs.forEach((r: AnyRecord) => { const count = new Set(placements.filter(p => p.requirementId === r.id).flatMap(p => p.periodIds.map(periodId => String(p.day) + '|' + periodId))).size; if (count < Number(r.lessonsPerWeek)) { const relatedUnits = units.filter(u => u.reqs.some((q: AnyRecord) => q.id === r.id)); const candidateSlots = relatedUnits.reduce((sum, u) => sum + (unitCandidates.get(u.key) || []).length, 0); const label = (getClass(r.classId)?.name || 'Class') + ' · ' + (getSubject(r.subjectId)?.name || 'Subject'); const reason = candidateSlots === 0 ? 'No valid candidate slots exist. Check the class bell schedule, active lesson periods, lesson pattern, required room, and hard placement rules.' : 'Placed ' + count + ' of ' + r.lessonsPerWeek + ' required lesson periods. The scheduler considered ' + candidateSlots + ' raw candidate slots and used ' + candidateChecks + ' indexed candidate checks across ' + nodes + ' search nodes, but could not retain all of them in the best conflict-free combination within the search budget. Check teacher/class/room clashes and hard constraints; this is not proof that the lessons are impossible.'; unscheduled.push({ requirementId: r.id, label, reason }); } });
  const hasValidatedCompleteCandidate = (complete || foundComplete) && !validator.length && !unscheduled.length;
  const status: ScheduleResult['status'] = hasValidatedCompleteCandidate ? 'Complete' : limitReached ? 'Search limit reached' : 'Partial';
  const message = status === 'Complete' ? (deepSearch ? 'Deep Search found a complete candidate and independent hard-constraint validation passed. It compares candidate placements using subject distribution and enabled soft preferences, retaining the best-scoring complete candidate explored within its time/node limits. Global optimality is not proven.' : 'All required events were scheduled and independent hard-constraint validation passed.') : status === 'Search limit reached' ? 'The bounded search time or node budget was reached before a fully validated complete timetable was found. This does not prove the timetable is impossible.' : 'A valid partial candidate was produced; review unscheduled events and validation findings.';
  return { status, placements, scheduledPeriods: placements.reduce((sum, p) => sum + p.periodIds.length, 0), unscheduled, violations: validator, softScore: chosen.reduce((sum, x) => sum + x.candidate.score, 0), exploredNodes: nodes, searchMode: deepSearch ? 'Deep' : 'Quick', searchBudget: budget, budgetExhausted: limitReached, optimalityProven: false, searchStats: { candidateChecks, conflictChecks, prunedBranches }, message };
}
export function validateSchedule(data: AnyRecord, placements: ScheduledPart[], constraints: AnyRecord[] = []): string[] {
  const errors: string[] = [];
  const reqs = effectiveRequirements(data);
  const periods = data.periods || [];
  const classes = data.classes || [], teachers = data.teachers || [], subjects = data.subjects || [], rooms = data.rooms || [];
  const describeRequirement = (r: AnyRecord) => {
    const className = classes.find((x: AnyRecord) => x.id === r.classId)?.name || 'Unknown class';
    const subjectName = subjects.find((x: AnyRecord) => x.id === r.subjectId)?.name || 'Unknown subject';
    const teacherName = teachers.find((x: AnyRecord) => x.id === r.teacherId)?.name || 'Unknown teacher';
    const divisionName = r.divisionId ? (data.divisions || []).find((d: AnyRecord) => d.id === r.divisionId)?.name : '';
    return className + ' · ' + subjectName + ' (Teacher: ' + teacherName + ')' + (divisionName ? ' [Division: ' + divisionName + ']' : '');
  };
  reqs.forEach((r: AnyRecord) => {
    const requirementPlacements = placements.filter(p => p.requirementId === r.id);
    const count = new Set(requirementPlacements.flatMap(p => p.periodIds.map(periodId => String(p.day) + '|' + periodId))).size;
    // Cross-boundary division doubles are represented by two linked one-period
    // halves on separate effective requirements (shared half + continuing half).
    // They are validated as a pair below; they must not be counted as a configured
    // double block against either segment's local doubleLessonsPerWeek (often 0).
    const doubleEvents = new Set(requirementPlacements
      .filter(p => p.lessonBlockType === 'Double' && !p.divisionDoublePairId)
      .map(p => p.day + ':' + p.periodIds[0])).size;
    const expectedDoubles = Number(r.doubleLessonsPerWeek ?? (r.lessonPattern === 'Double required' ? Math.floor(Number(r.lessonsPerWeek || 0) / 2) : 0));
    if (doubleEvents !== expectedDoubles) errors.push('Double lesson count mismatch for ' + describeRequirement(r) + ': expected ' + expectedDoubles + ' double block(s), but found ' + doubleEvents + '.');
    if (count !== Number(r.lessonsPerWeek)) errors.push('Weekly count mismatch for ' + describeRequirement(r) + ': expected ' + r.lessonsPerWeek + ' lessons/week, but only ' + count + ' were scheduled.');
    if (!teachers.some((t: AnyRecord) => t.id === r.teacherId && t.status === 'Active') || !subjects.some((s: AnyRecord) => s.id === r.subjectId && s.status === 'Active') || !classes.some((c: AnyRecord) => c.id === r.classId && c.status === 'Active')) errors.push('Invalid class, subject, or teacher reference for ' + describeRequirement(r) + '.');
    if (!data.teacherSubjects?.some((x: AnyRecord) => x.teacherId === r.teacherId && x.subjectId === r.subjectId)) errors.push('Teacher qualification failure for ' + describeRequirement(r) + '.');
  });
  const reqById = new Map(reqs.map((r: AnyRecord) => [r.id, r]));
  const enabledHardConstraints = constraints.filter((c: AnyRecord) => c.enabled && c.classification === 'Hard');
  const appliesTo = (c: AnyRecord, r: AnyRecord) => {
    const teacherTargets = Array.isArray(c.teacherIds) && c.teacherIds.length > 0;
    const classTargets = Array.isArray(c.classIds) && c.classIds.length > 0;
    const subjectTargets = Array.isArray(c.subjectIds) && c.subjectIds.length > 0;
    if (teacherTargets || classTargets || subjectTargets) return (!teacherTargets || c.teacherIds.includes(r.teacherId)) && (!classTargets || c.classIds.includes(r.classId)) && (!subjectTargets || c.subjectIds.includes(r.subjectId));
    if (c.scope === 'school' || !c.scope) return true;
    if (c.scope === 'teachers') return c.teacherIds?.includes(r.teacherId);
    if (c.scope === 'classes') return c.classIds?.includes(r.classId);
    if (c.scope === 'subjects') return c.subjectIds?.includes(r.subjectId);
    return true;
  };
  const numericValues = (value: any): number[] => Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : [];
  placements.forEach(p => {
    const r = reqById.get(p.requirementId) as AnyRecord | undefined;
    if (!r) return;
    enabledHardConstraints.forEach(c => {
      if (!appliesTo(c, r)) return;
      const params = c.parameters && typeof c.parameters === 'object' ? c.parameters : {};
      if (Array.isArray(params.allowedPeriods) && params.allowedPeriods.length && p.periodOrders.some(order => !numericValues(params.allowedPeriods).includes(Number(order)))) errors.push('Allowed-period constraint violation for ' + describeRequirement(r) + ': one or more lessons are outside the configured allowed lesson numbers.');
    });
  });
  placements.forEach(p => {
    const req = reqById.get(p.requirementId) as AnyRecord | undefined;
    const sequence = p.periodIds.map(id => periods.find((period: AnyRecord) => period.id === id)).filter(Boolean) as AnyRecord[];
    if (req?.lessonPattern === 'Double required' && sequence.length !== 2 && !p.divisionDoublePairId) errors.push('Required double lesson is not represented as a two-period event for ' + describeRequirement(req) + '.');
    for (let i = 1; i < sequence.length; i++) if (sequence[i].scheduleId !== sequence[i - 1].scheduleId || Number(sequence[i].order) !== Number(sequence[i - 1].order) + 1 || mins(sequence[i - 1].end) !== mins(sequence[i].start)) errors.push('Non-consecutive lesson periods for ' + (req ? describeRequirement(req) : 'an unknown requirement') + '.');
  });
  const crossDoubleGroups = new Map<string, ScheduledPart[]>();
  placements.filter(p => p.divisionDoublePairId).forEach(p => { const list = crossDoubleGroups.get(p.divisionDoublePairId!) || []; list.push(p); crossDoubleGroups.set(p.divisionDoublePairId!, list); });
  crossDoubleGroups.forEach((parts, pairId) => {
    // The continuing subject is represented by two linked one-period placements:
    // doublePart 1 in the shared slot and doublePart 2 in the independent slot.
    // Other division members may participate in the first slot as ordinary singles.
    const halves = parts.filter(p => p.lessonBlockType === 'Double' && (p.doublePart === 1 || p.doublePart === 2) && p.periodIds.length === 1);
    const first = halves.filter(p => p.doublePart === 1);
    const second = halves.filter(p => p.doublePart === 2);
    if (first.length !== 1 || second.length !== 1) {
      errors.push('Division cross-boundary double ' + pairId + ' must have exactly one first-half and one second-half placement.');
      return;
    }
    const a = first[0], b = second[0];
    const aPeriod = periods.find((x: AnyRecord) => x.id === a.periodIds[0]);
    const bPeriod = periods.find((x: AnyRecord) => x.id === b.periodIds[0]);
    if (!aPeriod || !bPeriod || a.day !== b.day || a.classId !== b.classId || a.subjectId !== b.subjectId || a.teacherId !== b.teacherId || Number(bPeriod.order) !== Number(aPeriod.order) + 1 || mins(aPeriod.end) !== mins(bPeriod.start) || aPeriod.type !== 'Lesson' || bPeriod.type !== 'Lesson') {
      errors.push('Division cross-boundary double ' + pairId + ' must be two consecutive teaching periods for the same continuing subject and teacher, without a break or lunch.');
      return;
    }
    parts.filter(p => !halves.includes(p)).forEach(part => {
      if (part.periodIds.length !== 1 || part.day !== a.day || part.classId !== a.classId || part.periodIds[0] !== a.periodIds[0] || part.lessonBlockType === 'Double') {
        errors.push('Division cross-boundary participant ' + part.requirementId + ' must be a single lesson in the first period of double ' + pairId + '.');
      }
    });
  });
  const flat = placements.flatMap(p => p.periodIds.map(id => ({ p, period: periods.find((x: AnyRecord) => x.id === id) })));
  for (let i = 0; i < flat.length; i++) for (let j = i + 1; j < flat.length; j++) {
    const a = flat[i], b = flat[j];
    if (!a.period || !b.period || a.p.day !== b.p.day || !overlaps(a.period, b.period)) continue;
    const reqA = reqById.get(a.p.requirementId) as AnyRecord | undefined;
    const reqB = reqById.get(b.p.requirementId) as AnyRecord | undefined;
    const sameCombinedEvent = Boolean(reqA?.combinedGroupId && reqA.combinedGroupId === reqB?.combinedGroupId);
    const separateDivisionGroups = Boolean(reqA?.divisionId && reqB?.divisionId && reqA.studentGroupId && reqB?.studentGroupId && reqA.studentGroupId !== reqB.studentGroupId);
    const division = separateDivisionGroups ? (data.divisions || []).find((d: AnyRecord) => d.id === reqA?.divisionId || d.id === reqB?.divisionId) : null;
    const partialDoubleSingle = Boolean(separateDivisionGroups && ((a.p.periodIds.length === 2 && b.p.periodIds.length === 1) || (b.p.periodIds.length === 2 && a.p.periodIds.length === 1)));
    const crossBoundarySharedOverlap = Boolean(
      partialDoubleSingle &&
      ((a.p.divisionDoublePairId && a.p.doublePart === 1 && a.p.periodIds.length === 1 && a.p.periodIds[0] === b.p.periodIds[0]) ||
       (b.p.divisionDoublePairId && b.p.doublePart === 1 && b.p.periodIds.length === 1 && b.p.periodIds[0] === a.p.periodIds[0])) &&
      reqA?.divisionSyncGroupId && reqA.divisionSyncGroupId === reqB?.divisionSyncGroupId
    );
    if (a.p.classId === b.p.classId && a.p.requirementId !== b.p.requirementId && (!separateDivisionGroups || (partialDoubleSingle && !division?.allowPartialOverlap && !crossBoundarySharedOverlap))) errors.push(partialDoubleSingle && !crossBoundarySharedOverlap ? 'Partial double/single overlap is disabled for this division.' : 'Class overlap: ' + a.p.classId + ' on ' + a.period.name + '.');
    if (a.p.teacherId === b.p.teacherId && a.p.requirementId !== b.p.requirementId && !sameCombinedEvent) errors.push('Teacher overlap: ' + a.p.teacherId + ' on ' + a.period.name + '.');
    if (a.p.roomId && a.p.roomId === b.p.roomId && a.p.requirementId !== b.p.requirementId && !sameCombinedEvent) errors.push('Room overlap: ' + a.p.roomId + ' on ' + a.period.name + '.');
  }
  const consecutiveRuleViolations = new Set<string>();
  const teacherRules = enabledHardConstraints.filter((c: AnyRecord) => c.category === 'Teacher consecutive single lessons');
  teacherRules.forEach(rule => {
    const params = rule.parameters && typeof rule.parameters === 'object' ? rule.parameters : {};
    if (params.preventConsecutiveSingleLessons === false) return;
    const maxOverall = Math.max(1, Number(params.maxConsecutiveSingleLessons ?? 1));
    const maxSameClass = Math.max(1, Number(params.maxConsecutiveSameClassSingleLessons ?? 1));
    const byTeacherDay = new Map<string, { order: number; classId: string; duration: number }[]>();
    placements.forEach(p => {
      const r = reqById.get(p.requirementId) as AnyRecord | undefined;
      // This rule is strictly about consecutive single-lesson placements.
      // Exclude ordinary doubles and division doubles represented as linked
      // one-period halves; those halves are still part of a double event.
      if (!r || !appliesTo(rule, r) || p.lessonBlockType === 'Double' || Boolean(p.divisionDoublePairId) || p.periodIds.length !== 1) return;
      const key = r.teacherId + '|' + p.day;
      const list = byTeacherDay.get(key) || [];
      list.push({ order: Number(p.periodOrders[0]), classId: r.classId, duration: p.periodIds.length });
      byTeacherDay.set(key, list);
    });
    byTeacherDay.forEach((list, teacherDayKey) => {
      list.sort((a, b) => a.order - b.order);
      const [teacherId, dayText] = teacherDayKey.split('|');
      const teacherName = teachers.find((t: AnyRecord) => t.id === teacherId)?.name || 'Unknown teacher';
      const dayName = DAYS[Number(dayText)] || 'Unknown day';
      let overallRun = 0;
      let sameClassRun = 0;
      let previous = -Infinity;
      let previousClass = '';
      list.forEach(item => {
        if (item.order === previous + 1) overallRun += 1; else overallRun = 1;
        if (item.order === previous + 1 && item.classId === previousClass) sameClassRun += 1; else sameClassRun = 1;
        if (overallRun > maxOverall || sameClassRun > maxSameClass) {
          const involved = list
            .filter(x => x.order >= item.order - Math.max(maxOverall, maxSameClass) && x.order <= item.order)
            .map(x => ({ ...x, className: classes.find((c: AnyRecord) => c.id === x.classId)?.name || 'Unknown class' }));
          const classNames = unique(involved.map(x => x.className));
          const lessonNumbers = unique(involved.map(x => x.order)).sort((a, b) => a - b);
          consecutiveRuleViolations.add(
            rule.name + ' — Teacher: ' + teacherName + '; Day: ' + dayName +
            '; lesson number(s): ' + lessonNumbers.join(', ') +
            '; class(es): ' + classNames.join(', ')
          );
        }
        previous = item.order;
        previousClass = item.classId;
      });
    });
  });
  consecutiveRuleViolations.forEach(message => errors.push('Teacher consecutive-single constraint violation: ' + message + '.'));
  placements.forEach(p => {    if (p.roomId && !rooms.some((r: AnyRecord) => r.id === p.roomId && r.status === 'Active')) errors.push('Invalid room reference for ' + (reqById.get(p.requirementId) ? describeRequirement(reqById.get(p.requirementId) as AnyRecord) : 'an unknown requirement') + '.'); });
  const describeDivisionSync = (groupId: string, expected: AnyRecord[]) => {
    const separator = groupId.lastIndexOf(':');
    const divisionId = separator >= 0 ? groupId.slice(0, separator) : groupId;
    const syncName = separator >= 0 ? groupId.slice(separator + 1) : '';
    const division = (data.divisions || []).find((d: AnyRecord) => d.id === divisionId);
    const syncLabel = /^shared[-_ ]?/i.test(syncName)
      ? 'Shared Set ' + syncName.replace(/^shared[-_ ]?/i, '')
      : syncName || 'Shared Set';
    const members = expected.map((r: AnyRecord) => {
      const divisionMember = division?.members?.find((m: AnyRecord) => m.id === r.divisionMemberId);
      const memberIndex = division?.members?.findIndex((m: AnyRecord) => m.id === r.divisionMemberId) ?? -1;
      const groupLabel = memberIndex >= 0 ? 'Group ' + String.fromCharCode(65 + memberIndex) : 'student group';
      const subjectName = subjects.find((s: AnyRecord) => s.id === r.subjectId)?.name || 'Unknown subject';
      const className = classes.find((c: AnyRecord) => c.id === r.classId)?.name || 'Unknown class';
      const configuredGroup = divisionMember?.studentGroupId ? ' (' + groupLabel + ')' : '';
      return className + ' ' + subjectName + configuredGroup;
    });
    return (division?.name || 'Unknown division') + ' (' + syncLabel + ')' + (members.length ? ': ' + members.join(' and ') : '');
  };
  const sharedRequirementGroups = new Map<string, AnyRecord[]>();
  reqs.filter((r: AnyRecord) => r.divisionSyncGroupId).forEach((r: AnyRecord) => {
    const list = sharedRequirementGroups.get(r.divisionSyncGroupId) || [];
    list.push(r);
    sharedRequirementGroups.set(r.divisionSyncGroupId, list);
  });
  sharedRequirementGroups.forEach((expected, groupId) => {
    const items = placements.filter(p => p.divisionSyncGroupId === groupId);
    const syncDescription = describeDivisionSync(groupId, expected);
    const memberSlots = expected.map((requirement: AnyRecord) => {
      const memberPlacements = items.filter(p => p.requirementId === requirement.id);
      const slotSignatures = memberPlacements.flatMap(p => p.periodIds.map(id => {
        const period = periods.find((x: AnyRecord) => x.id === id);
        return period ? p.day + '|' + mins(period.start) + '|' + mins(period.end) : p.day + '|missing|' + id;
      }));
      const eventSignatures = memberPlacements.map(p => {
        const eventPeriods = p.periodIds.map(id => periods.find((x: AnyRecord) => x.id === id)).filter(Boolean) as AnyRecord[];
        if (!eventPeriods.length) return p.day + '|missing-event';
        const starts = eventPeriods.map(period => mins(period.start));
        const ends = eventPeriods.map(period => mins(period.end));
        return p.day + '|' + Math.min(...starts) + '|' + Math.max(...ends);
      }).sort();
      const duplicateSlots = slotSignatures.length !== unique(slotSignatures).length;
      const duplicateEvents = eventSignatures.length !== unique(eventSignatures).length;
      const expectedPeriods = Number(requirement.lessonsPerWeek) || 0;
      if (slotSignatures.length !== expectedPeriods || duplicateSlots || duplicateEvents) {
        const subjectName = subjects.find((s: AnyRecord) => s.id === requirement.subjectId)?.name || 'member';
        errors.push('Division synchronization problem — ' + syncDescription + '. ' + subjectName + ' has ' + unique(slotSignatures).length + ' unique shared period slots across ' + memberPlacements.length + ' placement records; expected ' + expectedPeriods + ' periods. ' + (duplicateSlots || duplicateEvents ? 'Duplicate placement slots or lesson events were detected. ' : '') + 'Check this member’s shared-period count and regenerate the timetable.');
      }
      return { requirement, slotSignatures: slotSignatures.slice().sort(), eventSignatures };
    });
    if (memberSlots.length > 1) {
      const reference = memberSlots[0];
      memberSlots.slice(1).forEach(member => {
        const sameSlots = reference.slotSignatures.length === member.slotSignatures.length && reference.slotSignatures.every((slot, index) => slot === member.slotSignatures[index]);
        const sameEvents = reference.eventSignatures.length === member.eventSignatures.length && reference.eventSignatures.every((event, index) => event === member.eventSignatures[index]);
        const mixedBlockFormats = expected.some((r: AnyRecord) => Number(r.doubleLessonsPerWeek || 0) !== Number(expected[0].doubleLessonsPerWeek || 0) || (r.lessonPattern || 'Single lessons only') !== (expected[0].lessonPattern || 'Single lessons only'));
        if (!mixedBlockFormats && (!sameSlots || !sameEvents)) errors.push('Division synchronization time mismatch — ' + syncDescription + '. ' + describeRequirement(reference.requirement) + ' and ' + describeRequirement(member.requirement) + ' do not have identical shared-period slots and lesson intervals. Review their Shared Set membership, shared-period counts, and bell schedules so every shared lesson uses matching actual times, then regenerate the timetable.');
      });
    }
  });
  return unique(errors);
}
