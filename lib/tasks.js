import { nextRepeatDue, reminderTimestamp, todayISO, dueTimestamp, isOverdue, isValidDateISO, isValidTimeISO } from "./time.js";

export const PRIORITIES = ["P1", "P2", "P3", "P4"];
export const STATUSES = ["todo", "doing", "done", "trashed"];
export const REPEAT_RULES = ["none", "daily", "weekly", "monthly", "interval", "workdays"];

export class TaskError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newId(prefix) {
  let out = "";
  for (let i = 0; i < 10; i += 1) out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return `${prefix}_${out}`;
}

const clampText = (value, max) => String(value ?? "").trim().slice(0, max);

function cleanDate(value, label) {
  const text = clampText(value, 10);
  if (!text) return null;
  if (!isValidDateISO(text)) throw new TaskError(`${label} 不是有效日期（应为 YYYY-MM-DD）`);
  return text;
}

function cleanTime(value) {
  const text = clampText(value, 5);
  if (!text) return null;
  if (!isValidTimeISO(text)) throw new TaskError("时间不是有效值（应为 HH:MM）");
  return text;
}

export function cleanRepeat(value) {
  if (!value || typeof value !== "object") return { rule: "none" };
  const rule = REPEAT_RULES.includes(value.rule) ? value.rule : "none";
  if (rule === "none") return { rule: "none" };
  const repeat = { rule };
  if (rule === "interval") repeat.intervalDays = Math.min(365, Math.max(1, Number(value.intervalDays) || 1));
  if (rule === "weekly") {
    const days = Array.isArray(value.weekdays) ? value.weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
    repeat.weekdays = [...new Set(days)].sort();
    if (!repeat.weekdays.length) repeat.weekdays = [new Date().getDay()];
  }
  return repeat;
}

export function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[,\s]+/);
  return [...new Set(list.map((t) => clampText(t, 24)).filter(Boolean))].slice(0, 12);
}

/** 归一化写入字段；只处理传入的 key，未传的保持原值。 */
export function applyTaskInput(task, input = {}, { creating = false } = {}) {
  if (input.title !== undefined) task.title = clampText(input.title, 200);
  if (input.notes !== undefined) task.notes = clampText(input.notes, 4000);
  if (input.priority !== undefined) {
    if (!PRIORITIES.includes(input.priority)) throw new TaskError("优先级需为 P1-P4");
    task.priority = input.priority;
  }
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw new TaskError("状态不合法");
    task.status = input.status;
  }
  if (input.due !== undefined) task.due = cleanDate(input.due, "截止日期");
  if (input.dueTime !== undefined) task.dueTime = cleanTime(input.dueTime);
  if (input.remindMinutes !== undefined) {
    const n = input.remindMinutes === null || input.remindMinutes === "" ? null : Number(input.remindMinutes);
    task.remindMinutes = n === null || Number.isNaN(n) ? null : Math.min(43_200, Math.max(0, Math.round(n)));
  }
  if (input.tags !== undefined) task.tags = cleanTags(input.tags);
  if (input.projectId !== undefined) task.projectId = clampText(input.projectId, 40) || null;
  if (input.parentId !== undefined) task.parentId = clampText(input.parentId, 40) || null;
  if (input.repeat !== undefined) task.repeat = cleanRepeat(input.repeat);
  if (input.snoozedUntil !== undefined) task.snoozedUntil = input.snoozedUntil ? new Date(input.snoozedUntil).toISOString() : null;
  if (creating) {
    task.title = clampText(input.title, 200);
    if (!task.title) throw new TaskError("任务标题不能为空");
  } else if (input.title !== undefined && !task.title) {
    throw new TaskError("任务标题不能为空");
  }
}

export function buildTask(input, now = new Date()) {
  const task = {
    id: newId("t"),
    title: "",
    notes: "",
    priority: "P2",
    status: "todo",
    due: null,
    dueTime: null,
    remindMinutes: null,
    tags: [],
    projectId: null,
    parentId: null,
    repeat: { rule: "none" },
    reminderDismissedAt: null,
    snoozedUntil: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    completedAt: null,
    order: now.getTime(),
  };
  applyTaskInput(task, input, { creating: true });
  if (task.status === "done") task.completedAt = now.toISOString();
  return task;
}

export function indexTasks(data) {
  const byId = new Map();
  for (const task of data.tasks) byId.set(task.id, task);
  const children = new Map();
  for (const task of data.tasks) {
    if (!task.parentId || !byId.has(task.parentId)) continue;
    const list = children.get(task.parentId) ?? [];
    list.push(task);
    children.set(task.parentId, list);
  }
  return { byId, children };
}

function descendantsOf(data, taskId, acc = []) {
  const { children } = indexTasks(data);
  const walk = (id) => {
    for (const child of children.get(id) ?? []) {
      acc.push(child);
      walk(child.id);
    }
  };
  walk(taskId);
  return acc;
}

function touch(task, now) {
  task.updatedAt = now.toISOString();
}

/** 完成任务；重复任务完成时生成下一次实例。返回 { task, spawned } */
export function completeTask(data, taskId, done, now = new Date()) {
  const task = data.tasks.find((t) => t.id === taskId);
  if (!task) throw new TaskError("任务不存在", 404);
  if (task.status === "trashed") throw new TaskError("请先从回收站恢复该任务");

  if (done) {
    task.status = "done";
    task.completedAt = now.toISOString();
    touch(task, now);
    const rule = task.repeat?.rule ?? "none";
    let spawned = null;
    if (rule !== "none" && !task.parentId) {
      const nextDue = nextRepeatDue(task.due, task.repeat, now);
      spawned = buildTask(
        {
          title: task.title,
          notes: task.notes,
          priority: task.priority,
          due: nextDue,
          dueTime: task.dueTime,
          remindMinutes: task.remindMinutes,
          tags: task.tags,
          projectId: task.projectId,
          repeat: task.repeat,
        },
        now
      );
      spawned.id = newId("t");
      spawned.order = now.getTime();
      data.tasks.push(spawned);
    }
    return { task, spawned };
  }

  task.status = "todo";
  task.completedAt = null;
  touch(task, now);
  return { task, spawned: null };
}

/** 移入/移出回收站（含子任务）。purge=true 时彻底删除。 */
export function trashTask(data, taskId, now = new Date(), purge = false) {
  const task = data.tasks.find((t) => t.id === taskId);
  if (!task) throw new TaskError("任务不存在", 404);
  const group = [task, ...descendantsOf(data, taskId)];
  if (purge) {
    const ids = new Set(group.map((t) => t.id));
    data.tasks = data.tasks.filter((t) => !ids.has(t.id));
    return { removed: ids.size };
  }
  const willTrash = task.status !== "trashed";
  for (const item of group) {
    if (willTrash && item.status === "done") item.doneBeforeTrash = true;
    item.status = willTrash ? "trashed" : item.doneBeforeTrash ? "done" : "todo";
    if (!willTrash) delete item.doneBeforeTrash;
    touch(item, now);
  }
  task.trashedAt = willTrash ? now.toISOString() : null;
  return { count: group.length, trashed: willTrash };
}

export function restoreTask(data, taskId, now = new Date()) {
  const task = data.tasks.find((t) => t.id === taskId);
  if (!task) throw new TaskError("任务不存在", 404);
  if (task.status !== "trashed") return { task };
  if (task.parentId) {
    const parent = data.tasks.find((t) => t.id === task.parentId);
    if (!parent || parent.status === "trashed") task.parentId = null;
  }
  task.status = task.doneBeforeTrash ? "done" : "todo";
  delete task.doneBeforeTrash;
  task.trashedAt = null;
  touch(task, now);
  for (const child of descendantsOf(data, taskId)) {
    if (child.status !== "trashed") continue;
    child.status = child.doneBeforeTrash ? "done" : "todo";
    delete child.doneBeforeTrash;
    child.trashedAt = null;
    touch(child, now);
  }
  return { task };
}

export function projectMap(data) {
  const map = new Map();
  for (const p of data.projects) map.set(p.id, p);
  return map;
}

/** 待提醒任务：提醒时间已到、未被稍后提醒/关闭遮住。 */
export function dueReminders(data, now = new Date()) {
  const out = [];
  const nowMs = now.getTime();
  for (const task of data.tasks) {
    if (task.status === "done" || task.status === "trashed" || !task.due) continue;
    if (task.snoozedUntil && new Date(task.snoozedUntil).getTime() > nowMs) continue;
    const trigger = reminderTimestamp(task, data.settings);
    if (trigger === null || trigger > nowMs) continue;
    if (task.reminderDismissedAt && new Date(task.reminderDismissedAt).getTime() >= trigger) continue;
    out.push({
      id: task.id,
      title: task.title,
      due: task.due,
      dueTime: task.dueTime,
      priority: task.priority,
      overdue: isOverdue(task, now, data.settings),
      dueAt: dueTimestamp(task, data.settings),
      triggerAt: trigger,
    });
  }
  return out.sort((a, b) => a.triggerAt - b.triggerAt).slice(0, 50);
}

/** 视图过滤：today / upcoming / all / todo / done / trashed / overdue / next */
export function filterTasks(tasks, { view = "all", projectId = "", tag = "", priority = "", search = "", status = "" } = {}, now = new Date(), settings = {}) {
  const today = todayISO(now);
  const week = new Date(now.getTime() + 7 * 86_400_000);
  const keyword = String(search || "").trim().toLowerCase();
  return tasks.filter((task) => {
    if (view === "today" && task.due !== today) return false;
    if (view === "upcoming") {
      if (!task.due) return false;
      const ts = dueTimestamp(task, settings);
      if (task.due < today || ts > week.getTime()) return false;
    }
    if (view === "overdue" && !isOverdue(task, now, settings)) return false;
    if (view === "next" && task.status !== "todo") return false;
    if (view === "done" && task.status !== "done") return false;
    if (view === "trashed" && task.status !== "trashed") return false;
    if (view === "active" && (task.status === "done" || task.status === "trashed")) return false;
    if (status && task.status !== status) return false;
    if (projectId && task.projectId !== projectId) return false;
    if (priority && task.priority !== priority) return false;
    if (tag && !task.tags.includes(tag)) return false;
    if (keyword) {
      const hay = `${task.title} ${task.notes ?? ""} ${task.tags.join(" ")}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });
}

const PRIORITY_RANK = { P1: 0, P2: 1, P3: 2, P4: 3 };

function makeComparator(mode, now, settings) {
  const rank = (task) => PRIORITY_RANK[task.priority] ?? 9;
  const dueRank = (task) => {
    if (!task.due) return Number.MAX_SAFE_INTEGER;
    const ts = dueTimestamp(task, settings);
    return Number.isFinite(ts) ? ts : Number.MAX_SAFE_INTEGER;
  };
  if (mode === "created") return (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));
  if (mode === "priority") return (a, b) => rank(a) - rank(b) || dueRank(a) - dueRank(b);
  if (mode === "due") return (a, b) => dueRank(a) - dueRank(b) || rank(a) - rank(b);
  return (a, b) => {
    const od = Number(isOverdue(b, now, settings)) - Number(isOverdue(a, now, settings));
    if (od) return od;
    const sd = String(a.status).localeCompare(String(b.status));
    if (sd) return sd;
    return dueRank(a) - dueRank(b) || rank(a) - rank(b) || String(a.createdAt).localeCompare(String(b.createdAt));
  };
}

/** 排序并把子任务紧跟在父任务之后。 */
export function sortTasks(tasks, mode = "smart", now = new Date(), settings = {}) {
  const cmp = makeComparator(mode, now, settings);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const childrenOf = new Map();
  const tops = [];
  for (const task of tasks) {
    const parent = task.parentId ? byId.get(task.parentId) : null;
    if (parent) {
      const list = childrenOf.get(parent.id) ?? [];
      list.push(task);
      childrenOf.set(parent.id, list);
    } else {
      tops.push(task);
    }
  }
  tops.sort(cmp);
  const out = [];
  const walk = (task) => {
    out.push(task);
    for (const child of (childrenOf.get(task.id) ?? []).sort(cmp)) walk(child);
  };
  for (const task of tops) walk(task);
  return out;
}

export { descendantsOf };
