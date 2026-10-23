import assert from "node:assert/strict";
import { test } from "node:test";
import fs, { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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

test("JsonStore：业务抛错不污染缓存或磁盘，队列可继续成功", async () => {
  const dir = await mkdtemp(join(tmpdir(), "todo-store-"));
  const file = join(dir, "tasks.json");
  const store = new JsonStore(file);
  await store.save();
  const committed = await store.read();
  await assert.rejects(store.update(async (draft) => {
    draft.tasks.push({ id: "失败" });
    draft.settings.weekStart = 0;
    throw new Error("业务失败");
  }), /业务失败/);
  assert.equal(await store.read(), committed, "失败后仍是原已提交对象");
  assert.equal(committed.tasks.length, 0);
  assert.equal(committed.settings.weekStart, 1);
  assert.equal(JSON.parse(await readFile(file, "utf8")).tasks.length, 0);
  const result = await store.update((draft) => { draft.tasks.push({ id: "成功" }); return "已保存"; });
  assert.equal(result, "已保存");
  assert.deepEqual((await store.read()).tasks, [{ id: "成功" }]);
});

test("JsonStore：保存期间 read 仅返回已提交对象，钩子读取不死锁", { timeout: 5000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "todo-store-"));
  const file = join(dir, "tasks.json");
  const store = new JsonStore(file);
  await store.save();
  const committed = await store.read();
  let release;
  let entered;
  const started = new Promise((r) => { entered = r; });
  const gate = new Promise((r) => { release = r; });
  let hookSnapshot;
  store.onWrite = async () => { hookSnapshot = await store.read(); entered(); await gate; };
  const writing = store.update((draft) => { draft.tasks.push({ id: "尚未提交" }); });
  await started;
  try {
    assert.equal(await store.read(), committed);
    assert.equal(hookSnapshot, committed);
    assert.deepEqual(committed.tasks, []);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).tasks, []);
  } finally {
    release();
    await writing;
  }
  assert.notEqual(await store.read(), committed);
  assert.deepEqual(committed.tasks, [], "提交不能回写此前暴露的对象");
  assert.deepEqual((await store.read()).tasks, [{ id: "尚未提交" }]);
});

test("JsonStore：备份失败不提交，read 返回对象仍支持种子修改后 save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "todo-store-"));
  const file = join(dir, "tasks.json");
  const store = new JsonStore(file);
  const data = await store.read();
  data.seeded = true;
  data.tasks.push({ id: "种子" });
  await store.save();
  const before = await store.read();
  const raw = await readFile(file, "utf8");
  store.onWrite = async () => { throw new Error("备份失败"); };
  await assert.rejects(store.update((draft) => { draft.tasks.push({ id: "失败" }); }), /备份失败/);
  assert.equal(await store.read(), before);
  assert.deepEqual(before.tasks, [{ id: "种子" }]);
  assert.equal(await readFile(file, "utf8"), raw);
  store.onWrite = null;
  await store.update((draft) => { draft.tasks.push({ id: "成功" }); });
  assert.equal((await store.read()).seeded, true);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).tasks, [{ id: "种子" }, { id: "成功" }]);
});

for (const operation of ["writeFile", "rename"]) {
  test(`JsonStore：${operation} 失败清理自己的临时文件且不污染缓存`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "todo-store-"));
    const file = join(dir, "tasks.json");
    const store = new JsonStore(file);
    await store.save();
    const committed = await store.read();
    const unrelated = join(dir, "unrelated.tmp");
    await writeFile(unrelated, "不要删除其他写入的临时文件");
    const original = fs[operation];
    let fail = true;
    t.mock.method(fs, operation, async (...args) => {
      if (fail && String(args[0]).startsWith(`${file}.`)) {
        if (operation === "writeFile") await original(args[0], "部分写入", "utf8");
        throw Object.assign(new Error("模拟磁盘失败"), { code: "EIO" });
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await assert.rejects(store.update((draft) => { draft.tasks.push({ id: "失败" }); }), /模拟磁盘失败/);
    assert.equal(await store.read(), committed);
    assert.deepEqual(committed.tasks, []);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).tasks, []);
    assert.deepEqual((await readdir(dir)).sort(), ["tasks.json", "unrelated.tmp"]);
    fail = false;
    await store.update((draft) => { draft.tasks.push({ id: "成功" }); });
    assert.deepEqual((await store.read()).tasks, [{ id: "成功" }]);
  });
}

test("JsonStore：首次并发 read/update 共用加载，加载失败后可重试", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "todo-store-"));
  const file = join(dir, "tasks.json");
  await writeFile(file, JSON.stringify(makeData({ tasks: [{ id: "已有" }] })));
  const store = new JsonStore(file);
  const originalRead = fs.readFile;
  let count = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  t.mock.method(fs, "readFile", async (...args) => {
    if (args[0] === file) { count += 1; await gate; }
    return originalRead(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const readers = Array.from({ length: 10 }, () => store.read());
  const writing = store.update((draft) => { draft.tasks.push({ id: "新增" }); });
  try {
    assert.equal(count, 1, "首次加载只能读取磁盘一次");
  } finally {
    release();
    await Promise.all([...readers, writing]);
  }
  assert.deepEqual((await store.read()).tasks, [{ id: "已有" }, { id: "新增" }]);
  const brokenFile = join(dir, "broken.json");
  await writeFile(brokenFile, "{ broken");
  const broken = new JsonStore(brokenFile);
  const failures = await Promise.allSettled([broken.read(), broken.read()]);
  assert.ok(failures.every((r) => r.status === "rejected"));
  await writeFile(brokenFile, JSON.stringify(makeData()));
  assert.deepEqual((await broken.read()).tasks, []);
});
