import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonStore, DEFAULT_DATA } from "../lib/store.js";
import { buildTask, completeTask, dueReminders, restoreTask, sortTasks, trashTask, TaskError, applyTaskInput } from "../lib/tasks.js";
import { buildReview, buildStats, resolveRange } from "../lib/stats.js";
import { addDays, isValidDateISO, nextRepeatDue } from "../lib/time.js";

const NOW = new Date("2026-10-12T17:00:00");
const TODAY = "2026-10-12";

function makeData(overrides = {}) {
  return { ...structuredClone(DEFAULT_DATA), ...overrides };
}

test("重复规则：按原到期日推进并跳过过去的日期", () => {
  assert.equal(nextRepeatDue("2026-10-10", { rule: "daily" }, NOW), "2026-10-12");
  assert.equal(nextRepeatDue("2026-10-11", { rule: "interval", intervalDays: 3 }, NOW), "2026-10-14");
  assert.equal(nextRepeatDue(TODAY, { rule: "weekly", weekdays: [5] }, NOW), "2026-10-16", "本周一下次周五");
  assert.equal(nextRepeatDue(TODAY, { rule: "monthly" }, NOW), "2026-11-12");
  assert.equal(nextRepeatDue("2026-10-31", { rule: "monthly" }, NOW), "2026-11-30");
  assert.equal(nextRepeatDue("2026-10-12", { rule: "workdays" }, NOW), "2026-10-13");
  assert.equal(nextRepeatDue(TODAY, { rule: "none" }, NOW), null);
});

test("日期校验拒绝 2026-13-40 这类假日期", () => {
  assert.equal(isValidDateISO("2026-02-30"), false);
  assert.equal(isValidDateISO("2026-10-12"), true);
  assert.throws(() => applyTaskInput({}, { due: "2026-13-40" }), TaskError);
  assert.throws(() => applyTaskInput({}, { dueTime: "99:99" }), TaskError);
});

test("完成任务生成下一次实例并保留重复/提醒/项目", () => {
  const data = makeData({ projects: [{ id: "p1", name: "工作", color: "#000000" }] });
  const task = buildTask({ title: "写周报", due: TODAY, dueTime: "18:00", remindMinutes: 60, projectId: "p1", repeat: { rule: "weekly", weekdays: [5] }, tags: ["例行"] }, NOW);
  data.tasks.push(task);

  const { spawned } = completeTask(data, task.id, true, NOW);
  assert.equal(task.status, "done");
  assert.equal(task.completedAt, NOW.toISOString());
  assert.ok(spawned, "应生成下一次实例");
  assert.equal(spawned.due, "2026-10-16", "每周五重复");
  assert.equal(spawned.dueTime, "18:00");
  assert.equal(spawned.remindMinutes, 60);
  assert.equal(spawned.projectId, "p1");
  assert.deepEqual(spawned.tags, ["例行"]);
  assert.equal(spawned.status, "todo");
});

test("子任务完成后不再生成重复实例", () => {
  const data = makeData();
  const parent = buildTask({ title: "父" }, NOW);
  const child = buildTask({ title: "子", parentId: parent.id, due: TODAY, repeat: { rule: "daily" } }, NOW);
  data.tasks.push(parent, child);
  const result = completeTask(data, child.id, true, NOW);
  assert.equal(result.spawned, null);
});

test("完成/取消父任务不改动子任务状态", () => {
  const data = makeData();
  const parent = buildTask({ title: "父" }, NOW);
  const child = buildTask({ title: "子", parentId: parent.id }, NOW);
  const doneChild = buildTask({ title: "已完成子", parentId: parent.id, status: "done" }, NOW);
  data.tasks.push(parent, child, doneChild);

  completeTask(data, parent.id, true, NOW);
  assert.equal(child.status, "todo", "勾选父任务不应替用户完成子任务");
  assert.equal(doneChild.status, "done");

  completeTask(data, parent.id, false, NOW);
  assert.equal(parent.status, "todo");
  assert.equal(child.status, "todo");
  assert.equal(doneChild.status, "done");
});

test("回收站级联：删除带走子任务，恢复后回到原状态", () => {
  const data = makeData();
  const parent = buildTask({ title: "父" }, NOW);
  const child = buildTask({ title: "子", parentId: parent.id }, NOW);
  const doneChild = buildTask({ title: "已完成子", parentId: parent.id, status: "done" }, NOW);
  data.tasks.push(parent, child, doneChild);

  const trashed = trashTask(data, parent.id, NOW);
  assert.equal(trashed.count, 3);
  assert.ok(data.tasks.every((t) => t.status === "trashed"));

  restoreTask(data, parent.id, NOW);
  assert.equal(parent.status, "todo");
  assert.equal(doneChild.status, "done", "原本已完成的任务恢复后仍是完成态");
  const purged = trashTask(data, parent.id, NOW, true);
  assert.equal(purged.removed, 3);
  assert.equal(data.tasks.length, 0);
});

test("提醒：到时/逾期才出现，snooze 与 dismiss 会隐藏", () => {
  const data = makeData({ settings: { ...DEFAULT_DATA.settings } });
  const future = buildTask({ title: "未来", due: addDays(TODAY, 3), remindMinutes: 0 }, NOW);
  const nowDue = buildTask({ title: "现在", due: TODAY, dueTime: "16:00", remindMinutes: 0 }, NOW);
  const late = buildTask({ title: "逾期", due: addDays(TODAY, -2), remindMinutes: 30 }, NOW);
  const soon = buildTask({ title: "稍后提醒", due: TODAY, dueTime: "16:30", remindMinutes: 0 }, NOW);
  data.tasks.push(future, nowDue, late, soon);

  const ids = () => dueReminders(data, NOW).map((r) => r.title);
  assert.deepEqual(new Set(ids()), new Set(["逾期", "现在", "稍后提醒"]));
  assert.equal(dueReminders(data, NOW).find((r) => r.title === "逾期").overdue, true);

  soon.snoozedUntil = new Date(NOW.getTime() + 30 * 60_000).toISOString();
  assert.equal(ids().includes("稍后提醒"), false);
  nowDue.reminderDismissedAt = NOW.toISOString();
  assert.equal(ids().includes("现在"), false);
  assert.equal(ids().includes("未来"), false);
});

test("排序：子任务紧跟父任务，逾期优先", () => {
  const data = makeData();
  const plain = buildTask({ title: "普通", priority: "P3" }, NOW);
  const late = buildTask({ title: "逾期", due: addDays(TODAY, -1) }, NOW);
  const parent = buildTask({ title: "父", due: TODAY }, NOW);
  const child = buildTask({ title: "子", parentId: parent.id }, NOW);
  data.tasks.push(plain, late, parent, child);

  const order = sortTasks(data.tasks, "smart", NOW, data.settings).map((t) => t.title);
  assert.equal(order[0], "逾期");
  assert.ok(order.indexOf("子") === order.indexOf("父") + 1, `子任务应紧跟父任务: ${order}`);
  assert.deepEqual(sortTasks(data.tasks, "priority", NOW, data.settings).slice(-1)[0].title, "普通");
});

test("报表：趋势分桶、项目分布与完成率", () => {
  const data = makeData({ projects: [{ id: "p1", name: "工作", color: "#000000" }] });
  const created = buildTask({ title: "新建", projectId: "p1" }, NOW);
  const doneToday = buildTask({ title: "今天完成", projectId: "p1" }, new Date(NOW.getTime() - 3 * 86_400_000));
  const doneEarlier = buildTask({ title: "前天完成", projectId: "p1" }, new Date(NOW.getTime() - 6 * 86_400_000));
  const late = buildTask({ title: "逾期", due: addDays(TODAY, -3) }, NOW);
  data.tasks.push(created, doneToday, doneEarlier, late);
  completeTask(data, doneToday.id, true, NOW);
  completeTask(data, doneEarlier.id, true, new Date(NOW.getTime() - 2 * 86_400_000));

  const stats = buildStats(data, NOW, { days: 7 });
  assert.equal(stats.series.length, 7);
  assert.equal(stats.series.at(-1).date, TODAY);
  assert.equal(stats.summary.open, 2);
  assert.equal(stats.summary.done, 2);
  assert.equal(stats.summary.overdue, 1);
  assert.equal(stats.byProject.find((p) => p.projectId === "p1").done, 2);

  const onlyProject = buildStats(data, NOW, { days: 7, projectId: "p1" });
  assert.equal(onlyProject.summary.total, 3, "项目筛选生效");
});

test("回顾：区间解析、顺延清单与平均周期", () => {
  const data = makeData();
  const a = buildTask({ title: "本周完成", due: TODAY }, new Date(NOW.getTime() - 86_400_000));
  const b = buildTask({ title: "上周完成", due: addDays(TODAY, -6) }, new Date(NOW.getTime() - 12 * 86_400_000));
  const open = buildTask({ title: "顺延未完成", due: addDays(TODAY, -1) }, NOW);
  data.tasks.push(a, b, open);
  completeTask(data, a.id, true, NOW);
  completeTask(data, b.id, true, new Date("2026-10-06T09:00:00"));

  assert.deepEqual(resolveRange("week", NOW, 1), { start: "2026-10-12", end: "2026-10-18", label: "本周" });
  assert.deepEqual(resolveRange("lastWeek", NOW, 1).start, "2026-10-05");
  assert.equal(resolveRange("week", NOW, 0).start, "2026-10-11", "周日起始");

  const week = buildReview(data, NOW, { preset: "week" });
  assert.equal(week.counts.completed, 1);
  assert.deepEqual(week.carriedOver.map((t) => t.title), ["顺延未完成"]);
  assert.equal(week.counts.avgCycleDays, 1);

  const lastWeek = buildReview(data, NOW, { preset: "lastWeek" });
  assert.equal(lastWeek.counts.completed, 1);
  const custom = buildReview(data, NOW, { preset: "custom", start: "2026-10-01", end: "2026-10-31" });
  assert.equal(custom.counts.completed, 2);
});

test("JsonStore：落盘、重载与并发写不丢数据", async () => {
  const dir = await mkdtemp(join(tmpdir(), "todo-store-"));
  const file = join(dir, "tasks.json");
  const store = new JsonStore(file);
  assert.equal((await store.read()).tasks.length, 0);

  await Promise.all(
    Array.from({ length: 20 }, (_, i) => store.update((data) => { data.tasks.push({ id: `t${i}`, title: `任务${i}` }); }))
  );
  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.equal(raw.tasks.length, 20, "并发写入应全部保留");
  assert.equal(raw.tasks.filter((t) => !t.title).length, 0, "文件应为完整 JSON");

  const reloaded = new JsonStore(file);
  assert.equal((await reloaded.read()).tasks.length, 20);

  await writeFile(file, "{ broken");
  await assert.rejects(() => new JsonStore(file).read(), /解析失败/);
});
