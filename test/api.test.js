import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let file;
let notesDir;

async function call(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 静态资源/下载返回原文 */
  }
  return { status: res.status, json, text, headers: res.headers };
}
const ok = async (path, options) => {
  const res = await call(path, options);
  assert.ok(res.status >= 200 && res.status < 300, `${path} -> ${res.status} ${res.text.slice(0, 160)}`);
  return res.json;
};

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "todo-api-"));
  file = join(dir, "tasks.json");
  notesDir = join(dir, "notes");
  child = spawn(process.execPath, [join(ROOT, "server.js")], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", TODO_DATA_FILE: file, TODO_NOTES_DIR: notesDir, TODO_SEED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 60; i += 1) {
    const res = await fetch(`${BASE}/api/state`).catch(() => null);
    if (res?.ok) return;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error("服务未在 7 秒内就绪");
});

after(() => child?.kill());

test("首屏静态资源与示例数据", async () => {
  const page = await call("/");
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.text, /本地任务与笔记/);
  const state = await ok("/api/state");
  assert.equal(state.projects.length, 3);
  assert.ok(state.tasks.length >= 8);
  assert.equal(new Set(state.tasks.map((t) => t.id)).size, state.tasks.length);
});

test("禁止目录穿越", async () => {
  const res = await call("/%2e%2e/server.js");
  assert.ok(res.status === 403 || res.status === 404, `实际 ${res.status}`);
});

function localDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("任务增改删完整链路", async () => {
  const { task } = await ok("/api/tasks", { method: "POST", body: { title: "接口测试", priority: "P1", due: localDate(0), repeat: { rule: "daily" } } });
  assert.equal(task.priority, "P1");

  const bad = await call("/api/tasks", { method: "POST", body: { title: "   " } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /标题/);

  const badDate = await call(`/api/tasks/${task.id}`, { method: "PATCH", body: { due: "2026-13-40" } });
  assert.equal(badDate.status, 400);

  const patched = await ok(`/api/tasks/${task.id}`, { method: "PATCH", body: { title: "接口测试2", tags: ["a", "b"], dueTime: "09:30", remindMinutes: 45 } });
  assert.equal(patched.task.title, "接口测试2");
  assert.deepEqual(patched.task.tags, ["a", "b"]);

  const { spawned } = await ok(`/api/tasks/${task.id}/complete`, { method: "POST", body: { done: true } });
  assert.equal(spawned.due, localDate(1), "daily 重复应生成次日实例");

  const missing = await call("/api/tasks/t_不存在", { method: "PATCH", body: { title: "x" } });
  assert.equal(missing.status, 404);

  const trash = await ok(`/api/tasks/${task.id}/trash`, { method: "POST", body: {} });
  assert.equal(trash.trashed, true);
  const restored = await ok(`/api/tasks/${task.id}/restore`, { method: "POST", body: {} });
  assert.equal(restored.task.status, "done", "删除前已完成的任务恢复后仍是完成态");
  const purged = await ok(`/api/tasks/${task.id}/purge`, { method: "POST", body: {} });
  assert.equal(purged.removed >= 1, true);
});

test("父子任务：继承与防环", async () => {
  const dueDate = localDate(6);
  const parent = (await ok("/api/tasks", { method: "POST", body: { title: "父任务", due: dueDate, tags: ["继承"] } })).task;
  const child = (await ok("/api/tasks", { method: "POST", body: { title: "子任务", parentId: parent.id } })).task;
  assert.equal(child.due, dueDate);
  assert.deepEqual(child.tags, ["继承"]);
  const cycle = await call(`/api/tasks/${parent.id}`, { method: "PATCH", body: { parentId: child.id } });
  assert.equal(cycle.status, 400);
  assert.match(cycle.json.error, /子任务/);
  const self = await call(`/api/tasks/${parent.id}`, { method: "PATCH", body: { parentId: parent.id } });
  assert.equal(self.status, 400);
  assert.match(self.json.error, /自己/);
});

test("项目：重名拒绝、删除后任务转为未归类", async () => {
  const created = await ok("/api/projects", { method: "POST", body: { name: "接口项目", color: "#ff0000" } });
  const dup = await call("/api/projects", { method: "POST", body: { name: "接口项目" } });
  assert.equal(dup.status, 400);

  const task = (await ok("/api/tasks", { method: "POST", body: { title: "挂项目", projectId: created.project.id } })).task;
  const renamed = await ok(`/api/projects/${created.project.id}`, { method: "PATCH", body: { name: "接口项目2" } });
  assert.equal(renamed.project.name, "接口项目2");

  const removed = await ok(`/api/projects/${created.project.id}`, { method: "DELETE" });
  assert.equal(removed.moved, 1);
  const state = await ok("/api/state");
  assert.equal(state.tasks.find((t) => t.id === task.id).projectId, null);
});

test("提醒与设置接口", async () => {
  const task = (await ok("/api/tasks", { method: "POST", body: { title: "提醒接口", due: "2026-01-01", remindMinutes: 0 } })).task;
  const listed = await ok("/api/reminders");
  assert.ok(listed.reminders.some((r) => r.id === task.id && r.overdue));

  const snoozed = await ok(`/api/tasks/${task.id}/reminder`, { method: "POST", body: { action: "snooze", minutes: 60 } });
  assert.equal(snoozed.reminders.some((r) => r.id === task.id), false);
  const dismissed = await ok(`/api/tasks/${task.id}/reminder`, { method: "POST", body: { action: "dismiss" } });
  assert.equal(dismissed.reminders.some((r) => r.id === task.id), false);

  const settings = await ok("/api/settings", { method: "POST", body: { weekStart: 0, defaultRemindMinutes: 30, dueEodTime: "22:00", reminderPollSeconds: 45 } });
  assert.deepEqual(
    {
      weekStart: settings.settings.weekStart,
      defaultRemindMinutes: settings.settings.defaultRemindMinutes,
      dueEodTime: settings.settings.dueEodTime,
      reminderPollSeconds: settings.settings.reminderPollSeconds,
    },
    { weekStart: 0, defaultRemindMinutes: 30, dueEodTime: "22:00", reminderPollSeconds: 45 }
  );
  const bad = await ok("/api/settings", { method: "POST", body: { weekStart: 5, dueEodTime: "99:99", reminderPollSeconds: 9999 } });
  assert.equal(bad.settings.weekStart, 1);
  assert.equal(bad.settings.dueEodTime, "23:59");
  assert.equal(bad.settings.reminderPollSeconds, 600);
});

test("报表与回顾返回可渲染结构", async () => {
  const stats = await ok("/api/stats?days=14");
  assert.equal(stats.series.length, 14);
  assert.ok(stats.summary.total > 0);
  assert.ok(Array.isArray(stats.byProject) && stats.byProject.length > 0);
  assert.ok(stats.byPriority.every((p) => "open" in p));

  const review = await ok("/api/review?preset=week");
  assert.match(review.start, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok("completionRate" in review.counts);
  assert.ok(Array.isArray(review.carriedOver));

  const custom = await ok("/api/review?preset=custom&start=2026-10-05&end=2026-10-11");
  assert.deepEqual({ start: custom.start, end: custom.end }, { start: "2026-10-05", end: "2026-10-11" });
});

test("导出备份与持久化到数据文件", async () => {
  const res = await call("/api/export");
  assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="tasks-\d{4}-\d{2}-\d{2}\.json"/);
  const dumped = JSON.parse(res.text);
  assert.ok(dumped.tasks.length > 0);

  const { readFileSync } = await import("node:fs");
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.tasks.length, dumped.tasks.length, "接口数据应已落盘");
});

test("笔记接口完整链路：增查改删、搜索、导入导出", async () => {
  const created = await ok("/api/notes", { method: "POST", body: { title: "季度复盘", body: "# 复盘\n\n做得好的地方", tags: ["复盘", "工作"], pinned: true } });
  const id = created.note.id;
  assert.match(id, /^n_/);
  assert.equal(created.note.file, "季度复盘");
  assert.equal(created.note.words > 0, true);

  const list = await ok("/api/notes");
  assert.equal(list.notes[0].title, "季度复盘", "置顶在最前");
  assert.match(list.dir, /notes$/);
  assert.deepEqual(list.tags, ["工作", "复盘"].sort());

  const patched = await ok(`/api/notes/${id}`, { method: "PATCH", body: { title: "季度复盘 v2", body: "改过的正文" } });
  assert.equal(patched.note.file, "季度复盘 v2");
  assert.equal(patched.body, "改过的正文");
  assert.equal(patched.note.pinned, true);

  const search = await ok("/api/notes?q=改过");
  assert.equal(search.notes.length, 1);
  assert.match(search.notes[0].hit, /改过的正文/);

  const single = await call(`/api/notes/${id}/export`);
  assert.match(single.headers.get("content-disposition") ?? "", /attachment/);
  assert.match(single.text, /^---\nid: n_/);
  const all = await call("/api/notes/export/all");
  assert.match(all.text, /笔记合集（1 条）/);

  const imported = await ok("/api/notes/import", {
    method: "POST",
    body: { files: [{ name: "外部笔记.md", content: "# 外部笔记\n\n从别处搬来的内容" }, { name: "x.png", content: "x" }] },
  });
  assert.deepEqual(imported.created.map((c) => c.title), ["外部笔记"]);
  assert.equal(imported.skipped[0].name, "x.png");

  const missing = await call("/api/notes/n_不存在");
  assert.equal(missing.status, 404);
  const traversal = await call("/api/notes/..%2F..%2Fserver");
  assert.equal(traversal.status, 404, "穿越式 id 只当作不存在");

  const removed = await ok(`/api/notes/${id}`, { method: "DELETE" });
  assert.equal(removed.removed, id);
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(notesDir)).filter((f) => f.endsWith(".md"));
  assert.equal(files.includes("季度复盘 v2.md"), false, "删除应移除对应 .md 文件");
  assert.equal(files.includes("外部笔记.md"), true);
});

test("PWA：manifest、图标与服务脚本可被浏览器取用", async () => {
  const manifest = await call("/manifest.webmanifest");
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get("content-type"), /application\/manifest\+json/);
  const json = JSON.parse(manifest.text);
  assert.equal(json.display, "standalone");
  assert.equal(json.start_url, "/");
  assert.equal(json.scope, "/");
  assert.equal(json.id, "/");
  assert.ok(json.icons.some((i) => i.purpose === "maskable" && i.sizes === "512x512"));
  assert.ok(json.shortcuts.length >= 2, "桌面快捷方式");
  assert.ok(json.shortcuts.every((s) => s.url.startsWith("/?")), "快捷方式指向本站深链");

  const sizes = new Map([
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-maskable-512.png", 512],
    ["icon-32.png", 32],
  ]);
  for (const [name, size] of sizes) {
    const raw = await fetch(`${BASE}/icons/${name}`);
    assert.equal(raw.status, 200, name);
    assert.match(raw.headers.get("content-type"), /image\/png/, name);
    const buffer = Buffer.from(await raw.arrayBuffer());
    assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${name} PNG 签名`);
    assert.equal(buffer.readUInt32BE(16), size, `${name} 宽度`);
    assert.equal(buffer.readUInt32BE(20), size, `${name} 高度`);
    assert.equal(buffer[25], 6, `${name} 应为 RGBA`);
  }

  const page = await call("/");
  assert.match(page.text, /rel="manifest"/);
  assert.match(page.text, /theme-color/);
  const sw = await call("/sw.js");
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get("content-type"), /javascript/);
  assert.match(sw.text, /addEventListener\("fetch"/);
  assert.match(sw.text, /\/api\//, "API 请求需绕过缓存");
});

test("剪藏端点：建笔记、追加与空内容拒绝", async () => {
  const empty = await call("/api/notes/clips", { method: "POST", body: {} });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /剪藏内容为空/);

  const first = await ok("/api/notes/clips", {
    method: "POST",
    body: { note: "剪藏测试", title: "某篇文档", url: "https://example.com/doc", text: "第一行摘录\n第二行摘录" },
  });
  assert.equal(first.created, true);
  assert.equal(first.note.title, "剪藏测试");
  assert.deepEqual(first.note.tags, ["剪藏"]);
  assert.match(first.note.file, /^剪藏测试/);

  const second = await ok("/api/notes/clips", { method: "POST", body: { note: "剪藏测试", title: "另一篇", url: "https://example.com/2" } });
  assert.equal(second.created, false, "第二次应追加到同一篇");
  assert.equal(second.note.id, first.note.id);

  const detail = await ok(`/api/notes/${first.note.id}`);
  assert.match(detail.body, /### 某篇文档/);
  assert.match(detail.body, /> 第一行摘录\n> 第二行摘录/);
  assert.match(detail.body, /### 另一篇/);
  assert.equal((detail.body.match(/### /g) ?? []).length, 2);

  const long = await ok("/api/notes/clips", { method: "POST", body: { note: "剪藏测试", title: "超长", text: "字".repeat(5000) } });
  const clipped = await ok(`/api/notes/${long.note.id}`);
  assert.ok(clipped.body.length < 8000, "摘录长度受上限约束");

  const removed = await ok(`/api/notes/${first.note.id}`, { method: "DELETE" });
  assert.equal(removed.removed, first.note.id);
});

test("未知接口返回 404 JSON", async () => {
  const res = await call("/api/nope");
  assert.equal(res.status, 404);
  assert.match(res.json.error, /未知接口/);
});
