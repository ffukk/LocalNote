const MS_PER_DAY = 86_400_000;

export function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return fromDateISO(value);
  return new Date(value ?? Date.now());
}

export function fromDateISO(dateISO) {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function toDateISO(date) {
  const d = toDate(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayISO(now = new Date()) {
  return toDateISO(toDate(now));
}

export function isValidDateISO(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

export function isValidTimeISO(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [h, m] = value.split(":").map(Number);
  return h >= 0 && h < 24 && m >= 0 && m < 60;
}

export function localDateTime(dateISO, timeISO = "00:00") {
  const [y, m, d] = dateISO.split("-").map(Number);
  const [hh, mi] = (timeISO || "00:00").split(":").map(Number);
  return new Date(y, m - 1, d, hh, mi, 0, 0).getTime();
}

export function addDays(dateISO, days) {
  const d = fromDateISO(dateISO);
  d.setDate(d.getDate() + days);
  return toDateISO(d);
}

export function diffDays(aDateISO, bDateISO) {
  const a = localDateTime(aDateISO, "00:00");
  const b = localDateTime(bDateISO, "00:00");
  return Math.round((a - b) / MS_PER_DAY);
}

export function addMonths(dateISO, months) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(ny, nm, 0).getDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

export function weekdayOf(dateISO) {
  return fromDateISO(dateISO).getDay();
}

export function startOfWeek(date, weekStart = 1) {
  const d = new Date(toDate(date).getTime());
  d.setHours(0, 0, 0, 0);
  const shift = (d.getDay() - weekStart + 7) % 7;
  d.setDate(d.getDate() - shift);
  return toDateISO(d);
}

export function endOfWeek(date, weekStart = 1) {
  return addDays(startOfWeek(date, weekStart), 6);
}

export function startOfMonth(date) {
  const d = toDate(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export function endOfMonth(date) {
  const d = toDate(date);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

/** 任务的实际到期时间戳；无截止日期返回 null。仅有日期时按 settings.dueEodTime 计算。 */
export function dueTimestamp(task, settings = {}) {
  if (!task.due) return null;
  return localDateTime(task.due, task.dueTime || settings.dueEodTime || "23:59");
}

/** 提醒触发时间戳 = 到期时间提前 remindMinutes；无截止日期返回 null。 */
export function reminderTimestamp(task, settings = {}) {
  if (!task.due) return null;
  const dueTs = localDateTime(task.due, task.dueTime || settings.dueEodTime || "23:59");
  const minutes = task.remindMinutes ?? settings.defaultRemindMinutes ?? 0;
  return dueTs - minutes * 60_000;
}

export function isOverdue(task, now = new Date(), settings = {}) {
  if (!task.due || task.status === "done" || task.status === "trashed") return false;
  const ts = dueTimestamp(task, settings);
  return ts !== null && ts < toDate(now).getTime();
}

/**
 * 按重复规则推进到期日。以原到期日（无则今天）为基准，向前滚动直到不早于今天。
 * 规则: none | daily | weekly(weekdays) | monthly | interval(intervalDays) | workdays
 */
export function nextRepeatDue(currentDue, rule, now = new Date()) {
  if (!rule || rule.rule === "none") return null;
  const base = currentDue || todayISO(now);
  const floor = todayISO(now);
  let candidate = base;

  for (let i = 0; i < 400; i += 1) {
    if (rule.rule === "daily") {
      candidate = addDays(candidate, 1);
    } else if (rule.rule === "interval") {
      const n = Math.max(1, Number(rule.intervalDays) || 1);
      candidate = addDays(candidate, n);
    } else if (rule.rule === "workdays") {
      candidate = addDays(candidate, 1);
      while ([0, 6].includes(weekdayOf(candidate))) candidate = addDays(candidate, 1);
    } else if (rule.rule === "monthly") {
      candidate = addMonths(candidate, 1);
    } else if (rule.rule === "weekly") {
      const days = Array.isArray(rule.weekdays) && rule.weekdays.length ? rule.weekdays : [weekdayOf(base)];
      let next = addDays(candidate, 1);
      let guard = 0;
      while (!days.includes(weekdayOf(next)) && guard < 8) {
        next = addDays(next, 1);
        guard += 1;
      }
      candidate = next;
    } else {
      return null;
    }
    if (diffDays(candidate, floor) >= 0) return candidate;
  }
  return candidate;
}

export function formatDayLabel(dateISO) {
  const labels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${dateISO.slice(5).replace("-", "/")} ${labels[weekdayOf(dateISO)]}`;
}
