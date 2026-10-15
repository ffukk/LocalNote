import { addDays, dueTimestamp, endOfMonth, endOfWeek, isOverdue, startOfMonth, startOfWeek, todayISO, toDateISO } from "./time.js";
import { PRIORITIES } from "./tasks.js";

const PRIORITY_RANK = { P1: 0, P2: 1, P3: 2, P4: 3 };

function inScope(task, projectId) {
  if (task.status === "trashed") return false;
  if (projectId && task.projectId !== projectId) return false;
  return true;
}

function dayOf(isoTimestamp) {
  if (!isoTimestamp) return null;
  return toDateISO(new Date(isoTimestamp));
}

function rate(done, total) {
  return total ? Math.round((done / total) * 1000) / 10 : 0;
}

function emptyBucket() {
  return { total: 0, done: 0, open: 0, overdue: 0 };
}

function fill(bucket, task, now, settings) {
  bucket.total += 1;
  if (task.status === "done") bucket.done += 1;
  else bucket.open += 1;
  if (isOverdue(task, now, settings)) bucket.overdue += 1;
  return bucket;
}

/** 连续完成天数（从今天或昨天往回连续计数）。 */
function completionStreak(tasks, now) {
  const days = new Set(tasks.filter((t) => t.status === "done" && t.completedAt).map((t) => dayOf(t.completedAt)));
  let cursor = todayISO(now);
  if (!days.has(cursor)) {
    cursor = addDays(cursor, -1);
    if (!days.has(cursor)) return 0;
  }
  let streak = 0;
  while (days.has(cursor) && streak < 3650) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

export function buildStats(data, now = new Date(), { days = 14, projectId = "" } = {}) {
  const settings = data.settings;
  const tasks = data.tasks.filter((t) => inScope(t, projectId));
  const projects = data.projects;
  const nameOf = (id) => projects.find((p) => p.id === id)?.name ?? "未归类";

  const summary = emptyBucket();
  const dueToday = { count: 0 };
  const noDue = { count: 0 };
  for (const task of tasks) {
    fill(summary, task, now, settings);
    if (task.due === todayISO(now) && task.status !== "done") dueToday.count += 1;
    if (!task.due && task.status !== "done") noDue.count += 1;
  }

  const series = [];
  const start = addDays(todayISO(now), -(days - 1));
  const createdMap = new Map();
  const completedMap = new Map();
  for (const task of tasks) {
    const c = dayOf(task.createdAt);
    if (c && c >= start && c <= todayISO(now)) createdMap.set(c, (createdMap.get(c) ?? 0) + 1);
    const d = task.status === "done" ? dayOf(task.completedAt) : null;
    if (d && d >= start && d <= todayISO(now)) completedMap.set(d, (completedMap.get(d) ?? 0) + 1);
  }
  for (let i = 0; i < days; i += 1) {
    const date = addDays(start, i);
    series.push({ date, created: createdMap.get(date) ?? 0, completed: completedMap.get(date) ?? 0 });
  }

  const byProject = new Map();
  const byPriority = new Map(PRIORITIES.map((p) => [p, { ...emptyBucket(), priority: p }]));
  const tagMap = new Map();
  for (const task of tasks) {
    const key = task.projectId ?? "";
    if (!byProject.has(key)) byProject.set(key, { projectId: key, name: nameOf(key), ...emptyBucket() });
    fill(byProject.get(key), task, now, settings);
    if (task.status !== "done") byPriority.get(task.priority) && fill(byPriority.get(task.priority), task, now, settings);
    for (const tag of task.tags ?? []) {
      if (!tagMap.has(tag)) tagMap.set(tag, { tag, count: 0, open: 0 });
      tagMap.get(tag).count += 1;
      if (task.status !== "done") tagMap.get(tag).open += 1;
    }
  }

  return {
    now: now.toISOString(),
    rangeDays: days,
    summary: {
      total: summary.total,
      open: summary.open,
      done: summary.done,
      overdue: summary.overdue,
      dueToday: dueToday.count,
      noDue: noDue.count,
      doneRate: rate(summary.done, summary.total),
      streak: completionStreak(tasks, now),
    },
    series,
    byProject: [...byProject.values()].sort((a, b) => b.open - a.open || a.name.localeCompare(b.name, "zh")),
    byPriority: [...byPriority.values()].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]),
    topTags: [...tagMap.values()].sort((a, b) => b.count - a.count).slice(0, 12),
  };
}

export function resolveRange(preset, now = new Date(), weekStart = 1) {
  const today = todayISO(now);
  switch (preset) {
    case "lastWeek": {
      const s = addDays(startOfWeek(now, weekStart), -7);
      return { start: s, end: addDays(s, 6), label: "上周" };
    }
    case "month":
      return { start: startOfMonth(now), end: endOfMonth(now), label: "本月" };
    case "last30":
      return { start: addDays(today, -29), end: today, label: "近 30 天" };
    case "custom":
      return { start: today, end: today, label: "自定义" };
    case "week":
    default:
      return { start: startOfWeek(now, weekStart), end: endOfWeek(now, weekStart), label: "本周" };
  }
}

/** 周期回顾：区间内完成/新增、逾期、顺延未完成、按项目分布、平均完成周期。 */
export function buildReview(data, now = new Date(), { preset = "week", start = "", end = "", projectId = "" } = {}) {
  const settings = data.settings;
  const resolved = preset === "custom" && start && end ? { start, end, label: "自定义区间" } : resolveRange(preset, now, settings.weekStart);
  const lo = resolved.start < resolved.end ? resolved.start : resolved.end;
  const hi = resolved.start < resolved.end ? resolved.end : resolved.start;

  const tasks = data.tasks.filter((t) => inScope(t, projectId));
  const completed = tasks
    .filter((t) => t.status === "done" && t.completedAt && dayOf(t.completedAt) >= lo && dayOf(t.completedAt) <= hi)
    .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
  const created = tasks.filter((t) => dayOf(t.createdAt) >= lo && dayOf(t.createdAt) <= hi);
  const carriedOver = tasks.filter(
    (t) => t.status !== "done" && t.due && t.due <= hi && dayOf(t.createdAt) <= hi
  );
  const overdueNow = tasks.filter((t) => isOverdue(t, now, settings));

  const cycles = completed
    .map((t) => (new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime()) / 86_400_000)
    .filter((v) => Number.isFinite(v) && v >= 0);
  const perDay = new Map();
  for (const task of completed) {
    const day = dayOf(task.completedAt);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const bestDay = [...perDay.entries()].sort((a, b) => b[1] - a[1])[0];

  const projectStats = new Map();
  const nameOf = (id) => data.projects.find((p) => p.id === id)?.name ?? "未归类";
  for (const task of completed) {
    const key = task.projectId ?? "";
    if (!projectStats.has(key)) projectStats.set(key, { projectId: key, name: nameOf(key), completed: 0 });
    projectStats.get(key).completed += 1;
  }

  const brief = (t) => ({
    id: t.id,
    title: t.title,
    priority: t.priority,
    due: t.due,
    dueTime: t.dueTime,
    projectId: t.projectId || null,
    projectName: t.projectId ? nameOf(t.projectId) : "未归类",
    tags: t.tags ?? [],
    completedAt: t.completedAt,
    createdAt: t.createdAt,
    overdue: isOverdue(t, now, settings),
    dueAt: dueTimestamp(t, settings),
  });

  return {
    start: lo,
    end: hi,
    label: resolved.label ?? "区间",
    today: todayISO(now),
    counts: {
      created: created.length,
      completed: completed.length,
      carriedOver: carriedOver.length,
      overdueNow: overdueNow.length,
      completionRate: rate(completed.length, completed.length + carriedOver.length),
      avgCycleDays: cycles.length ? Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 10) / 10 : null,
      bestDay: bestDay ? { date: bestDay[0], count: bestDay[1] } : null,
    },
    completed: completed.map(brief),
    created: created.map(brief).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    carriedOver: carriedOver.map(brief).sort((a, b) => String(a.due).localeCompare(String(b.due))),
    overdue: overdueNow.map(brief).sort((a, b) => String(a.due).localeCompare(String(b.due))),
    byProject: [...projectStats.values()].sort((a, b) => b.completed - a.completed),
  };
}
