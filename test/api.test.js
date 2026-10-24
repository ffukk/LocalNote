import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let BASE;
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
  const script = `import { server } from ${JSON.stringify(new URL("../server.js", import.meta.url).href)};
    server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));`;
  child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, TODO_NO_LISTEN: "1", TODO_DATA_FILE: file, TODO_NOTES_DIR: notesDir, TODO_BACKUP_DIR: join(dir, "backups"), TODO_SEED: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("隔离服务启动超时")), 10000);
    child.once("message", ({ port }) => {
      clearTimeout(timeout);
      BASE = `http://127.0.0.1:${port}`;
      resolve();
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`隔离服务退出：${code}`)); });
  });
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

  const trash = await ok("/api/notes/trash");
  assert.equal(trash.items.length, 1);
  assert.equal(trash.items[0].title, "季度复盘 v2");
  const restored = await ok(`/api/notes/trash/${trash.items[0].trashFile}/restore`, { method: "POST" });
  assert.equal(restored.note.title, "季度复盘 v2");
  assert.equal((await ok("/api/notes/trash")).items.length, 0);

  await ok(`/api/notes/${restored.note.id}`, { method: "DELETE" });
  const listed = await ok("/api/notes/trash");
  const purged = await ok(`/api/notes/trash/${listed.items[0].trashFile}/purge`, { method: "POST" });
  assert.match(purged.purged, /季度复盘/);
  assert.equal((await ok("/api/notes/trash")).items.length, 0);
  const missingTrash = await call("/api/notes/trash/不存在的文件.md/purge", { method: "POST" });
  assert.equal(missingTrash.status, 404);
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

test("自动备份：当天首次写入后快照可见", async () => {
  const res = await ok("/api/backups");
  assert.equal(res.keepDays, 7);
  assert.match(res.dir, /backups$/);
  assert.ok(res.backups.length >= 1, "前面的写入应已触发当天快照");
  const today = res.backups[0];
  assert.match(today.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(today.files >= 1 && today.bytes > 0, JSON.stringify(today));
});

test("未知接口返回 404 JSON", async () => {
  const res = await call("/api/nope");
  assert.equal(res.status, 404);
  assert.match(res.json.error, /未知接口/);
});

function memoryStorage() {
  const items = new Map();
  return {
    get length() { return items.size; },
    key(index) { return [...items.keys()][index] ?? null; },
    getItem(key) { return items.get(String(key)) ?? null; },
    setItem(key, value) { items.set(String(key), String(value)); },
    removeItem(key) { items.delete(String(key)); },
  };
}

async function noteClient(mockApi, confirm = () => true, { storage, dir = "/test/notes" } = {}) {
  storage ??= memoryStorage();
  const source = await readFile(join(ROOT, "public", "app.js"), "utf8");
  const client = runInNewContext(source.replace(/^import .*\n/, "").replace(/\nboot\(\);\s*$/, "") + `
    api = mockApi;
    let renderCount = 0;
    const messages = [];
    render = async () => { renderCount++; };
    toast = (message) => { messages.push(message); };
    const editorNodes = [];
    const renderMarkdown = () => ({});
    el = (tag, props = {}, children = []) => {
      const node = { tag, props, children, appendChild: () => {} };
      editorNodes.push(node);
      return node;
    };
    ({state, saveNote, markNoteDirty, openNote, syncCurrentNote, deleteNote, newNote, setCurrentNote, reloadNote,
      persistNoteDraft: typeof persistNoteDraft === "function" ? persistNoteDraft : undefined,
      readNoteDrafts: typeof readNoteDrafts === "function" ? readNoteDrafts : undefined,
      recoverNoteDraft: typeof recoverNoteDraft === "function" ? recoverNoteDraft : undefined,
      discardNoteDraft: typeof discardNoteDraft === "function" ? discardNoteDraft : undefined,
      noteDraftStatusText: typeof noteDraftStatusText === "function" ? noteDraftStatusText : undefined,
      editor: () => { editorNodes.length = 0; noteEditorPane(); return editorNodes; },
      toasts: () => messages,
      renders: () => renderCount});`, {
    mockApi: async (...args) => {
      const data = await mockApi(...args);
      return Array.isArray(data?.notes) && data.dir === undefined ? { ...data, dir } : data;
    },
    localStorage: storage, crypto: { randomUUID },
    URLSearchParams, console, setTimeout: () => 1, clearTimeout: () => {}, confirm,
  });
  Object.assign(client.state.notes, {
    list: { dir, notes: [], tags: [] },
    currentId: "n_a", current: { id: "n_a", title: "A", revision: "r1", tags: [] },
    title: "A", body: "第一段", dirty: true, editVersion: 1,
  });
  return client;
}

function gate() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function noteResponse(body, revision = "r2") {
  return { note: { id: "n_a", title: "A", revision, tags: [] }, body };
}

const DRAFT_PREFIX = "localnote:draft:v1:";

function storageEntries(storage) {
  return Array.from({ length: storage.length }, (_, i) => {
    const key = storage.key(i);
    return [key, storage.getItem(key)];
  });
}

function storedDrafts(storage) {
  return storageEntries(storage).filter(([key]) => key.startsWith(DRAFT_PREFIX))
    .map(([key, value]) => ({ ...JSON.parse(value), key }));
}

function seedDraft(storage, overrides = {}) {
  const draft = {
    version: 1, dir: "/test/notes", noteId: "n_a", baseRevision: "r1",
    title: "恢复标题", tagsText: "工作, 草稿", body: "崩溃前的正文\n第二行",
    savedAt: "2026-01-01T10:00:00.000Z", ...overrides,
  };
  const key = DRAFT_PREFIX + randomUUID();
  storage.setItem(key, JSON.stringify(draft));
  return { ...draft, key };
}

function requireDraftFunctions(client, ...names) {
  for (const name of names) assert.equal(typeof client[name], "function", `尚未实现草稿接口：${name}`);
}

function oneStoredDraft(storage) {
  const drafts = storedDrafts(storage);
  assert.equal(drafts.length, 1, "应同步保留一个本地草稿快照");
  return drafts[0];
}

function editorDraft(client) {
  const n = client.state.notes;
  return {
    currentId: n.currentId, baseRevision: n.current?.revision,
    title: n.title, tagsText: n.tagsText, body: n.body,
    dirty: n.dirty, editVersion: n.editVersion, restoredDraft: Boolean(n.restoredDraft),
  };
}

test("自动保存：回包不能清除期间的新输入，连续写入且不重建编辑器", async () => {
  const started = gate();
  const release = gate();
  const writes = [];
  const client = await noteClient(async (path, options) => {
    if (options?.method === "PATCH") {
      writes.push(options.body);
      if (writes.length === 1) { started.resolve(); await release.promise; }
      return noteResponse(options.body.body, `r${writes.length + 1}`);
    }
    return { notes: [noteResponse("").note] };
  });
  const saving = client.saveNote({ silent: true });
  await started.promise;
  client.state.notes.body = "第一段，继续输入";
  client.markNoteDirty();
  release.resolve();
  await saving;
  assert.deepEqual(writes.map((p) => p.body), ["第一段", "第一段，继续输入"]);
  assert.equal(writes[1].baseRevision, "r2");
  assert.equal(client.state.notes.dirty, false);
  assert.equal(client.renders(), 0);
});

test("自动保存：写入失败保留草稿，切换笔记不得丢弃", async () => {
  const client = await noteClient(async (path, options) => {
    if (options?.method === "PATCH") throw new Error("模拟磁盘写入失败");
    return { note: { id: "n_b", title: "B", tags: [], revision: "b1" }, body: "B 正文" };
  });
  await client.saveNote({ silent: true });
  await client.openNote("n_b");
  assert.equal(client.state.notes.currentId, "n_a");
  assert.equal(client.state.notes.body, "第一段");
  assert.equal(client.state.notes.dirty, true);
});

test("自动保存：筛选列表不能清空未保存笔记或更新其版本基线", async () => {
  const client = await noteClient(async () => ({}));
  client.state.notes.list = { notes: [] };
  client.syncCurrentNote();
  assert.equal(client.state.notes.currentId, "n_a");
  assert.equal(client.state.notes.dirty, true);
  client.state.notes.list.notes = [{ id: "n_a", revision: "external", title: "外部标题", tags: [] }];
  client.syncCurrentNote();
  assert.equal(client.state.notes.current.revision, "r1");
});

test("自动保存：重复保存合并为单个请求，切换等待回包且不污染新笔记", async () => {
  const started = gate();
  const release = gate();
  let writes = 0;
  const client = await noteClient(async (path, options) => {
    if (options?.method === "PATCH") {
      writes++;
      started.resolve();
      await release.promise;
      return noteResponse(options.body.body);
    }
    if (path.endsWith("/n_b")) return { note: { id: "n_b", title: "B", tags: [], revision: "b1" }, body: "B 正文" };
    return { notes: [] };
  });
  const saving = client.saveNote({ silent: true });
  await started.promise;
  const again = client.saveNote();
  const switching = client.openNote("n_b");
  assert.equal(client.state.notes.currentId, "n_a");
  release.resolve();
  await Promise.all([saving, again, switching]);
  assert.equal(writes, 1);
  assert.equal(client.state.notes.currentId, "n_b");
  assert.equal(client.state.notes.current.revision, "b1");
  assert.equal(client.state.notes.body, "B 正文");
});

test("自动保存：目标笔记读取期间的新输入也要先保存", async () => {
  const started = gate();
  const release = gate();
  const writes = [];
  const client = await noteClient(async (path, options) => {
    if (options?.method === "PATCH") {
      writes.push(options.body.body);
      return noteResponse(options.body.body, `r${writes.length + 1}`);
    }
    if (path.endsWith("/n_b")) {
      started.resolve();
      await release.promise;
      return { note: { id: "n_b", title: "B", tags: [], revision: "b1" }, body: "B 正文" };
    }
    return { notes: [] };
  });
  const switching = client.openNote("n_b");
  await started.promise;
  client.state.notes.body = "读取期间新增";
  client.markNoteDirty();
  release.resolve();
  await switching;
  assert.deepEqual(writes, ["第一段", "读取期间新增"]);
  assert.equal(client.state.notes.currentId, "n_b");
});

test("自动保存：切换时列表加载期间仍编辑旧笔记，保存后才切换", async () => {
  const started = gate();
  const release = gate();
  const writes = [];
  const client = await noteClient(async (path, options) => {
    if (options?.method === "PATCH") {
      writes.push({ path, body: options.body.body });
      return noteResponse(options.body.body);
    }
    if (path.endsWith("/n_b")) return { note: { id: "n_b", title: "B", tags: [], revision: "b1" }, body: "B 正文" };
    started.resolve();
    await release.promise;
    return { notes: [] };
  });
  client.state.notes.dirty = false;
  const switching = client.openNote("n_b");
  await started.promise;
  const editingId = client.state.notes.currentId;
  client.state.notes.body = "列表加载期间新增";
  client.markNoteDirty();
  release.resolve();
  await switching;
  assert.equal(editingId, "n_a");
  assert.deepEqual(writes, [{ path: "/api/notes/n_a", body: "列表加载期间新增" }]);
  assert.equal(client.state.notes.currentId, "n_b");
  assert.equal(client.state.notes.body, "B 正文");
});

test("自动保存：旧编辑器事件不能污染新会话的正文、标题、标签或输入法状态", async () => {
  const client = await noteClient(async (path, options) => options?.method === "PATCH"
    ? { note: { id: "n_b", title: "B", tags: [], revision: "b2" }, body: options.body.body }
    : { notes: [] });
  const nodes = client.editor();
  client.setCurrentNote({ note: { id: "n_b", title: "B", tags: ["标签 B"], revision: "b1" }, body: "B 正文" });
  for (const node of nodes) {
    node.props.oninput?.({ target: { value: "旧编辑器事件" } });
    node.props.oncompositionstart?.();
  }
  assert.equal(client.state.notes.title, "B");
  assert.equal(client.state.notes.tagsText, "标签 B");
  assert.equal(client.state.notes.body, "B 正文");
  assert.equal(client.state.notes.dirty, false);
  client.markNoteDirty();
  assert.equal(await client.saveNote(), true);
});

test("自动保存：文件占用的 409 可重试，不当成版本冲突锁死", async () => {
  let busy = true;
  const client = await noteClient(async (path, options) => {
    if (options?.method === "PATCH") {
      if (busy) throw Object.assign(new Error("文件被其它程序占用"), { status: 409 });
      return noteResponse(options.body.body);
    }
    return { notes: [] };
  });
  assert.equal(await client.saveNote(), false);
  assert.equal(client.state.notes.conflict, false);
  assert.match(client.state.notes.saveError, /可重试/);
  busy = false;
  assert.equal(await client.saveNote(), true);
  assert.equal(client.state.notes.dirty, false);
});

test("自动保存：失败可以重试，版本冲突不能自动覆盖", async () => {
  let fail = true;
  let writes = 0;
  const client = await noteClient(async (path, options) => {
    if (options?.method === "PATCH") {
      writes++;
      if (fail) throw new Error("服务暂不可用");
      return noteResponse(options.body.body);
    }
    return { notes: [] };
  });
  assert.equal(await client.saveNote(), false);
  assert.equal(client.state.notes.dirty, true);
  fail = false;
  assert.equal(await client.saveNote(), true);
  assert.equal(writes, 2);
  assert.equal(client.state.notes.saveError, "");
  const conflict = await noteClient(async () => { throw Object.assign(new Error("版本冲突"), { status: 409, code: "NOTE_CONFLICT" }); });
  assert.equal(await conflict.saveNote(), false);
  conflict.state.notes.body = "冲突后的新草稿";
  conflict.markNoteDirty();
  assert.equal(await conflict.saveNote(), false);
  assert.equal(conflict.state.notes.body, "冲突后的新草稿");
  assert.equal(conflict.state.notes.conflict, true);
  assert.equal(conflict.state.notes.dirty, true);
});

test("自动保存：删除先保存，删除期间新增草稿不清空也不重新写回", async () => {
  const started = gate();
  const release = gate();
  const methods = [];
  const client = await noteClient(async (path, options) => {
    if (options?.method) methods.push(options.method);
    if (options?.method === "PATCH") return noteResponse(options.body.body);
    if (options?.method === "DELETE") { started.resolve(); await release.promise; return {}; }
    return { notes: [] };
  });
  const removing = client.deleteNote(client.state.notes.current);
  await started.promise;
  client.state.notes.body = "删除期间新增草稿";
  client.markNoteDirty();
  assert.equal(await client.saveNote(), false);
  release.resolve();
  await removing;
  assert.deepEqual(methods, ["PATCH", "DELETE"]);
  assert.equal(client.state.notes.body, "删除期间新增草稿");
  assert.equal(client.state.notes.dirty, true);
  assert.equal(client.state.notes.conflict, true);
});

test("重新载入：取消确认不请求磁盘、不改变草稿及冲突状态", async () => {
  let requests = 0;
  const prompts = [];
  const client = await noteClient(async () => { requests++; return noteResponse("磁盘正文"); }, (message) => {
    prompts.push(message);
    return false;
  });
  client.state.notes.conflict = true;
  client.state.notes.saveError = "版本冲突";
  await client.reloadNote();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /丢弃当前草稿.*下载草稿/);
  assert.equal(requests, 0);
  assert.equal(client.state.notes.body, "第一段");
  assert.equal(client.state.notes.current.revision, "r1");
  assert.equal(client.state.notes.dirty, true);
  assert.equal(client.state.notes.conflict, true);
  assert.equal(client.state.notes.saveError, "版本冲突");
  assert.equal(client.renders(), 0);
});

test("重新载入：确认后采用磁盘版本、清除冲突，并可按新版本保存", async () => {
  const writes = [];
  const reads = [];
  const client = await noteClient(async (path, options) => {
    if (options?.method === "PATCH") {
      writes.push(options.body);
      return noteResponse(options.body.body, "r3");
    }
    reads.push(path);
    return path.endsWith("/n_a") ? noteResponse("磁盘正文", "r2") : { notes: [] };
  });
  client.state.notes.conflict = true;
  client.state.notes.saveError = "版本冲突";
  await client.reloadNote();
  assert.deepEqual(reads, ["/api/notes/n_a"]);
  assert.equal(client.state.notes.body, "磁盘正文");
  assert.equal(client.state.notes.current.revision, "r2");
  assert.equal(client.state.notes.dirty, false);
  assert.equal(client.state.notes.conflict, false);
  assert.equal(client.state.notes.saveError, "");
  assert.equal(client.renders(), 1);
  client.state.notes.body = "基于磁盘版本继续编辑";
  client.markNoteDirty();
  assert.equal(await client.saveNote(), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].baseRevision, "r2");
  assert.equal(writes[0].body, "基于磁盘版本继续编辑");
});

test("重新载入：读取失败保留草稿与版本，解除互斥后可重试", async () => {
  let fail = true;
  const client = await noteClient(async () => {
    if (fail) throw new Error("服务暂不可用");
    return noteResponse("磁盘正文");
  });
  client.state.notes.conflict = true;
  await client.reloadNote();
  assert.equal(client.state.notes.body, "第一段");
  assert.equal(client.state.notes.current.revision, "r1");
  assert.equal(client.state.notes.dirty, true);
  assert.equal(client.state.notes.conflict, true);
  assert.equal(client.renders(), 0);
  fail = false;
  await client.reloadNote();
  assert.equal(client.state.notes.body, "磁盘正文");
  assert.equal(client.state.notes.dirty, false);
  assert.equal(client.state.notes.conflict, false);
  assert.equal(client.renders(), 1);
});

test("重新载入：等待期间新增输入优先于磁盘回包，草稿保留且可重新操作", async () => {
  const started = gate();
  const release = gate();
  const client = await noteClient(async () => {
    started.resolve();
    await release.promise;
    return noteResponse("磁盘正文");
  });
  client.state.notes.conflict = true;
  const loading = client.reloadNote();
  await started.promise;
  client.state.notes.body = "载入期间继续输入";
  client.markNoteDirty();
  release.resolve();
  await loading;
  assert.equal(client.state.notes.body, "载入期间继续输入");
  assert.equal(client.state.notes.current.revision, "r1");
  assert.equal(client.state.notes.dirty, true);
  assert.equal(client.state.notes.conflict, true);
  assert.equal(client.renders(), 0);
  await client.reloadNote();
  assert.equal(client.state.notes.body, "磁盘正文");
  assert.equal(client.state.notes.dirty, false);
  assert.equal(client.renders(), 1);
});

test("本地草稿：同步快照可由共享 storage 的新 VM 发现，独立 VM 不串数据", async () => {
  const storage = memoryStorage();
  const first = await noteClient(async () => ({}), undefined, { storage });
  Object.assign(first.state.notes, { title: "未保存标题", tagsText: "甲, 乙", body: "重启前正文\n第二行" });
  first.markNoteDirty();
  const { key, savedAt, ...payload } = oneStoredDraft(storage);
  assert.deepEqual(payload, {
    version: 1, dir: "/test/notes", noteId: "n_a", baseRevision: "r1",
    title: "未保存标题", tagsText: "甲, 乙", body: "重启前正文\n第二行",
  });
  assert.ok(Number.isFinite(new Date(savedAt).getTime()), "快照应有有效保存时间");
  const reopened = await noteClient(async () => ({}), undefined, { storage });
  const isolated = await noteClient(async () => ({}));
  for (const client of [first, reopened, isolated]) requireDraftFunctions(client, "readNoteDrafts");
  assert.equal(first.readNoteDrafts().drafts.length, 0, "不列出本编辑器所属快照");
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.readNoteDrafts().drafts)), [{ ...payload, savedAt, key }]);
  assert.equal(isolated.readNoteDrafts().drafts.length, 0);
});

test("本地草稿：打开笔记不自动采用或删除历史快照，也不 PATCH", async () => {
  const storage = memoryStorage();
  const draft = seedDraft(storage);
  const requests = [];
  const client = await noteClient(async (path, options) => { requests.push({ path, options }); return {}; }, undefined, { storage });
  requireDraftFunctions(client, "readNoteDrafts");
  client.setCurrentNote(noteResponse("磁盘正文", "r1"));
  const before = storageEntries(storage);
  assert.equal(client.readNoteDrafts().drafts[0].key, draft.key);
  assert.equal(client.state.notes.title, "A");
  assert.equal(client.state.notes.tagsText, "");
  assert.equal(client.state.notes.body, "磁盘正文");
  assert.equal(client.state.notes.dirty, false);
  assert.ok(!client.state.notes.restoredDraft);
  await client.saveNote({ silent: true });
  assert.deepEqual(requests, []);
  assert.deepEqual(storageEntries(storage), before);
  client.state.notes.body = "本会话输入";
  client.markNoteDirty();
  const own = storedDrafts(storage).find((d) => d.key !== draft.key);
  assert.ok(own, "当前编辑器应另建快照");
  client.state.notes.restoredDraft = true;
  client.setCurrentNote(noteResponse("再次打开", "r1"));
  assert.ok(!client.state.notes.restoredDraft);
  assert.equal(client.readNoteDrafts().drafts.length, 2, "重置所属键，不删除或接管旧快照");
});

test("本地草稿：同版本恢复只写本地，拒绝自动保存，手动保存使用旧基线并清理自己", async () => {
  const storage = memoryStorage();
  const draft = seedDraft(storage);
  const original = storageEntries(storage);
  const requests = [];
  const client = await noteClient(async (path, options) => {
    requests.push({ path, options });
    if (options?.method === "PATCH") return noteResponse(options.body.body, "r2");
    return path.endsWith("/n_a") ? noteResponse("磁盘正文", "r1") : { notes: [] };
  }, undefined, { storage });
  requireDraftFunctions(client, "recoverNoteDraft", "readNoteDrafts");
  client.setCurrentNote(noteResponse("磁盘正文", "r1"));
  await client.recoverNoteDraft(draft.key);
  assert.deepEqual(requests.map((r) => r.path), ["/api/notes/n_a", "/api/notes?"]);
  assert.ok(requests.every((r) => !r.options?.method || r.options.method === "GET"));
  assert.deepEqual(editorDraft(client), {
    currentId: "n_a", baseRevision: "r1", title: draft.title, tagsText: draft.tagsText, body: draft.body,
    dirty: true, editVersion: 1, restoredDraft: true,
  });
  assert.equal(client.state.notes.conflict, false);
  assert.equal(storage.getItem(draft.key), original[0][1]);
  const restored = storedDrafts(storage).filter((item) => item.key !== draft.key);
  assert.equal(restored.length, 1, "恢复时创建自己的不可变快照");
  assert.equal(restored[0].body, draft.body);
  assert.deepEqual(Array.from(client.readNoteDrafts().drafts, (item) => item.key), [draft.key]);
  await client.saveNote({ silent: true });
  assert.equal(requests.filter((r) => r.options?.method === "PATCH").length, 0);
  assert.equal(client.state.notes.dirty, true);
  assert.equal(await client.saveNote({ silent: false }), true);
  const writes = requests.filter((r) => r.options?.method === "PATCH");
  assert.equal(writes.length, 1);
  assert.deepEqual({ ...writes[0].options.body }, {
    title: draft.title, tags: draft.tagsText, body: draft.body, baseRevision: "r1",
  });
  assert.equal(client.state.notes.dirty, false);
  assert.deepEqual(storageEntries(storage), original, "手动保存只清理本页副本，原草稿保持不变");
});

test("本地草稿：磁盘版本不同则保留旧基线并阻止任何覆盖", async () => {
  const storage = memoryStorage();
  const draft = seedDraft(storage);
  const writes = [];
  const client = await noteClient(async (path, options) => {
    if (options?.method) writes.push(options.method);
    return path.endsWith("/n_a") ? noteResponse("外部新正文", "r9") : { notes: [noteResponse("", "r9").note] };
  }, undefined, { storage });
  requireDraftFunctions(client, "recoverNoteDraft");
  client.setCurrentNote(noteResponse("原编辑器", "r9"));
  await client.recoverNoteDraft(draft.key);
  assert.equal(client.state.notes.body, draft.body);
  assert.equal(client.state.notes.current.revision, "r1");
  assert.equal(client.state.notes.conflict, true);
  assert.ok(client.state.notes.saveError);
  client.syncCurrentNote();
  assert.equal(client.state.notes.current.revision, "r1");
  assert.equal(await client.saveNote({ silent: true }), false);
  assert.equal(await client.saveNote({ silent: false }), false);
  assert.deepEqual(writes, []);
  const snapshots = storedDrafts(storage);
  assert.equal(snapshots.length, 2);
  assert.ok(snapshots.every((item) => item.baseRevision === "r1" && item.body === draft.body));
  assert.deepEqual(snapshots.find((item) => item.key === draft.key), draft);
});

for (const failure of ["404", "网络失败", "列表失败"]) {
  test(`本地草稿：恢复遇到${failure}保留源记录与编辑器，不自动新建`, async () => {
    const storage = memoryStorage();
    const draft = seedDraft(storage);
    const requests = [];
    const client = await noteClient(async (path, options) => {
      requests.push(options?.method ?? "GET");
      if (path.endsWith("/n_a") && failure === "列表失败") return noteResponse("磁盘正文", "r1");
      throw Object.assign(new Error(failure), { status: failure === "404" ? 404 : 503 });
    }, undefined, { storage });
    requireDraftFunctions(client, "recoverNoteDraft");
    client.setCurrentNote({ note: { id: "n_b", title: "B", tags: [], revision: "b1" }, body: "B 正文" });
    const before = editorDraft(client);
    const saved = storageEntries(storage);
    await client.recoverNoteDraft(draft.key);
    assert.deepEqual(editorDraft(client), before);
    assert.deepEqual(storageEntries(storage), saved);
    assert.ok(requests.length > 0 && requests.every((m) => m === "GET"));
    assert.ok(client.state.notes.draftError || client.state.notes.saveError || client.toasts().length, "读取失败必须可见");
  });
}

for (const waitingFor of ["详情", "列表"]) {
  test(`本地草稿：恢复前保存旧编辑器，${waitingFor}等待期间再输入须再次 flush 且保护切换`, { timeout: 3000 }, async () => {
    const storage = memoryStorage();
    const draft = seedDraft(storage, { noteId: "n_b", baseRevision: "b1" });
    const started = gate();
    const release = gate();
    const writes = [];
    const reads = [];
    let detailRead = false;
    let blocked = false;
    const client = await noteClient(async (path, options) => {
      if (options?.method === "PATCH") {
        writes.push({ path, ...options.body });
        return noteResponse(options.body.body, `r${writes.length + 1}`);
      }
      reads.push(path);
      if (path.endsWith("/n_b")) detailRead = true;
      if (!blocked && detailRead && (waitingFor === "详情" ? path.endsWith("/n_b") : path.startsWith("/api/notes?"))) {
        blocked = true;
        started.resolve();
        await release.promise;
      }
      return path.endsWith("/n_b")
        ? { note: { id: "n_b", title: "B", tags: [], revision: "b1" }, body: "B 磁盘" }
        : { notes: [] };
    }, undefined, { storage });
    requireDraftFunctions(client, "recoverNoteDraft");
    const recovering = client.recoverNoteDraft(draft.key);
    let switching;
    try {
      await started.promise;
      assert.equal(client.state.notes.currentId, "n_a");
      assert.equal(writes.length, 1);
      client.state.notes.body = "恢复等待期间新增";
      client.markNoteDirty();
      switching = client.openNote("n_c");
    } finally {
      release.resolve();
      await Promise.all([recovering, switching]);
    }
    assert.deepEqual(writes.map((w) => [w.path, w.body, w.baseRevision]), [
      ["/api/notes/n_a", "第一段", "r1"], ["/api/notes/n_a", "恢复等待期间新增", "r2"],
    ]);
    assert.ok(!reads.includes("/api/notes/n_c"));
    assert.equal(client.state.notes.currentId, "n_b");
    assert.equal(client.state.notes.body, draft.body);
    assert.equal(client.state.notes.dirty, true);
    const snapshots = storedDrafts(storage);
    assert.equal(snapshots.length, 2);
    assert.ok(snapshots.every((item) => item.noteId === "n_b" && item.body === draft.body));
    assert.deepEqual(snapshots.find((item) => item.key === draft.key), draft);
  });
}

test("本地草稿：恢复前旧编辑器保存失败时停止切换，保留两份草稿", async () => {
  const storage = memoryStorage();
  const draft = seedDraft(storage, { noteId: "n_b", baseRevision: "b1" });
  const requests = [];
  const client = await noteClient(async (path, options) => {
    requests.push(options?.method ?? "GET");
    throw new Error("旧笔记保存失败");
  }, undefined, { storage });
  requireDraftFunctions(client, "recoverNoteDraft");
  const before = editorDraft(client);
  await client.recoverNoteDraft(draft.key);
  assert.deepEqual(editorDraft(client), before);
  assert.deepEqual(requests, ["PATCH"]);
  assert.ok(storage.getItem(draft.key));
  assert.equal(storedDrafts(storage).find((d) => d.noteId === "n_a")?.body, "第一段");
});

test("本地草稿：恢复时本地 set 失败保留所选源快照，不写服务器", async () => {
  const storage = memoryStorage();
  const draft = seedDraft(storage);
  const before = storageEntries(storage);
  const methods = [];
  const client = await noteClient(async (path, options) => {
    methods.push(options?.method ?? "GET");
    return path.endsWith("/n_a") ? noteResponse("磁盘正文", "r1") : { notes: [] };
  }, undefined, { storage });
  requireDraftFunctions(client, "recoverNoteDraft");
  client.setCurrentNote(noteResponse("磁盘正文", "r1"));
  storage.setItem = () => { throw new Error("模拟配额不足"); };
  await client.recoverNoteDraft(draft.key);
  assert.deepEqual(storageEntries(storage), before);
  assert.equal(client.state.notes.body, draft.body);
  assert.equal(client.state.notes.dirty, true);
  assert.ok(client.state.notes.draftError);
  assert.ok(methods.every((m) => m === "GET"));
});

test("本地草稿：保存开始即落地，两个回包 gate 验证新输入、基线推进及最终清理", { timeout: 3000 }, async () => {
  const storage = memoryStorage();
  const started = [gate(), gate()];
  const release = [gate(), gate()];
  const writes = [];
  const client = await noteClient(async (path, options) => {
    if (options?.method !== "PATCH") return { notes: [] };
    const index = writes.length;
    writes.push(options.body);
    started[index].resolve();
    await release[index].promise;
    return noteResponse(options.body.body, `r${index + 2}`);
  }, undefined, { storage });
  const saving = client.saveNote({ silent: true });
  try {
    await started[0].promise;
    assert.equal(oneStoredDraft(storage).body, "第一段", "无需先触发 markNoteDirty");
    Object.assign(client.state.notes, { title: "新标题", tagsText: "新标签", body: "保存中继续输入" });
    client.markNoteDirty();
    const during = oneStoredDraft(storage);
    assert.equal(during.body, "保存中继续输入");
    assert.equal(during.baseRevision, "r1");
    release[0].resolve();
    await started[1].promise;
    const next = oneStoredDraft(storage);
    assert.notEqual(next.key, during.key);
    assert.equal(next.title, "新标题");
    assert.equal(next.tagsText, "新标签");
    assert.equal(next.body, "保存中继续输入");
    assert.equal(next.baseRevision, "r2");
    assert.equal(writes[1].baseRevision, "r2");
    assert.equal(writes[1].body, next.body);
  } finally {
    release.forEach((g) => g.resolve());
    await saving;
  }
  assert.equal(await saving, true);
  assert.equal(client.state.notes.current.revision, "r3");
  assert.equal(client.state.notes.dirty, false);
  assert.equal(storage.length, 0);
});

test("本地草稿：服务器请求失败后内容与基线仍可重启恢复", async () => {
  const storage = memoryStorage();
  const client = await noteClient(async () => { throw new Error("网络断开"); }, undefined, { storage });
  assert.equal(await client.saveNote({ silent: true }), false);
  const draft = oneStoredDraft(storage);
  assert.equal(draft.body, "第一段");
  assert.equal(draft.baseRevision, "r1");
  assert.equal(client.state.notes.dirty, true);
  assert.match(client.state.notes.saveError, /网络断开/);
  const reopened = await noteClient(async () => ({}), undefined, { storage });
  requireDraftFunctions(reopened, "readNoteDrafts");
  assert.equal(reopened.readNoteDrafts().drafts[0].key, draft.key);
});

test("本地草稿：两个 VM 编辑同笔记互不覆盖，其一保存只删除自己", async () => {
  const storage = memoryStorage();
  const api = async (path, options) => options?.method === "PATCH" ? noteResponse(options.body.body) : { notes: [] };
  const first = await noteClient(api, undefined, { storage });
  const second = await noteClient(api, undefined, { storage });
  first.state.notes.body = "标签页一";
  first.markNoteDirty();
  const firstKey = oneStoredDraft(storage).key;
  second.state.notes.body = "标签页二";
  second.markNoteDirty();
  assert.equal(storage.length, 2);
  const other = storedDrafts(storage).find((d) => d.key !== firstKey);
  const otherValue = storage.getItem(other.key);
  requireDraftFunctions(first, "readNoteDrafts");
  assert.deepEqual(Array.from(first.readNoteDrafts().drafts, (d) => d.key), [other.key]);
  assert.equal(await first.saveNote({ silent: true }), true);
  assert.equal(storage.getItem(firstKey), null);
  assert.equal(storage.getItem(other.key), otherValue);
  assert.equal(oneStoredDraft(storage).body, "标签页二");
  assert.equal(second.state.notes.dirty, true);
});

test("本地草稿：恢复另一活动页快照再编辑，不能删除原页面的留存副本", async () => {
  const storage = memoryStorage();
  const original = seedDraft(storage);
  const api = async (path, options) => options?.method === "PATCH"
    ? noteResponse(options.body.body, "r2")
    : path.endsWith("/n_a") ? noteResponse("磁盘正文", "r1") : { notes: [] };
  const first = await noteClient(api, undefined, { storage });
  first.setCurrentNote(noteResponse("磁盘正文", "r1"));
  await first.recoverNoteDraft(original.key);
  const active = storedDrafts(storage).find((draft) => draft.key !== original.key);
  const activeValue = storage.getItem(active.key);
  const second = await noteClient(api, undefined, { storage });
  second.setCurrentNote(noteResponse("磁盘正文", "r1"));
  await second.recoverNoteDraft(active.key);
  second.state.notes.body = "另一页面恢复后继续修改";
  second.markNoteDirty();
  assert.equal(storage.getItem(active.key), activeValue, "恢复只克隆，不能接管活动页所属快照");
  assert.equal(await second.saveNote(), true);
  assert.equal(storage.getItem(active.key), activeValue, "另一页面保存后原稿仍可找回");
  const reopened = await noteClient(api, undefined, { storage });
  assert.ok(reopened.readNoteDrafts().drafts.some((draft) => draft.key === active.key && draft.body === original.body));
});

test("本地草稿：配额不足保留旧快照并显示错误，但不阻止服务器保存最新输入", async () => {
  const storage = memoryStorage();
  const writes = [];
  const client = await noteClient(async (path, options) => {
    if (options?.method !== "PATCH") return { notes: [] };
    writes.push(options.body);
    return noteResponse(options.body.body);
  }, undefined, { storage });
  client.markNoteDirty();
  oneStoredDraft(storage);
  const before = storageEntries(storage);
  storage.setItem = () => { throw Object.assign(new Error("模拟配额不足"), { name: "QuotaExceededError" }); };
  client.state.notes.body = "配额耗尽后输入";
  assert.doesNotThrow(() => client.markNoteDirty());
  requireDraftFunctions(client, "persistNoteDraft", "noteDraftStatusText");
  assert.doesNotThrow(() => client.persistNoteDraft());
  assert.deepEqual(storageEntries(storage), before);
  assert.ok(client.state.notes.draftError);
  assert.match(client.noteDraftStatusText(), /配额|本地|存储/);
  assert.equal(await client.saveNote({ silent: false }), true);
  assert.equal(writes[0].body, "配额耗尽后输入");
  assert.equal(client.state.notes.dirty, false);
  assert.equal(client.state.notes.saveError, "");
});

for (const operation of ["getItem", "key", "length", "removeItem"]) {
  test(`本地草稿：storage.${operation} 故障不能误报正文保存失败`, async () => {
    const storage = memoryStorage();
    const writes = [];
    const client = await noteClient(async (path, options) => {
      if (options?.method !== "PATCH") return { notes: [] };
      writes.push(options.body);
      return noteResponse(options.body.body);
    }, undefined, { storage });
    client.markNoteDirty();
    oneStoredDraft(storage);
    if (operation !== "removeItem") seedDraft(storage, { body: "待读取的历史草稿" });
    const fail = () => { throw new Error(`模拟 ${operation} 故障`); };
    if (operation === "length") Object.defineProperty(storage, "length", { get: fail });
    else storage[operation] = fail;
    if (operation !== "removeItem") {
      requireDraftFunctions(client, "readNoteDrafts");
      let result;
      assert.doesNotThrow(() => { result = client.readNoteDrafts(); });
      assert.ok(Array.isArray(result.drafts));
      assert.ok(result.error, "读取错误应返回给草稿 UI");
    }
    assert.equal(await client.saveNote({ silent: false }), true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body, "第一段");
    assert.equal(client.state.notes.dirty, false);
    assert.equal(client.state.notes.saveError, "");
    if (operation === "removeItem") assert.ok(client.state.notes.draftError);
  });
}

test("本地草稿：坏 JSON 和非法结构跳过并报错，目录隔离且不删除未知记录", async () => {
  const storage = memoryStorage();
  const older = seedDraft(storage);
  const newer = seedDraft(storage, { savedAt: "2026-01-02T10:00:00.000Z" });
  const foreign = seedDraft(storage, { dir: "/other/notes" });
  const valid = JSON.parse(storage.getItem(older.key));
  const invalid = [null, [], {}, { ...valid, version: 2 }, { ...valid, noteId: 42 },
    { ...valid, title: [] }, { ...valid, tagsText: [] }, { ...valid, body: null },
    { ...valid, baseRevision: null }, { ...valid, savedAt: "not-a-date" }];
  invalid.forEach((value) => storage.setItem(DRAFT_PREFIX + randomUUID(), JSON.stringify(value)));
  storage.setItem(DRAFT_PREFIX + randomUUID(), "{broken");
  storage.setItem("other-app-setting", "untouched");
  const requests = [];
  const client = await noteClient(async (path) => { requests.push(path); return {}; }, undefined, { storage });
  requireDraftFunctions(client, "readNoteDrafts", "recoverNoteDraft", "discardNoteDraft");
  client.setCurrentNote(noteResponse("磁盘正文", "r1"));
  const before = storageEntries(storage);
  const result = client.readNoteDrafts();
  assert.deepEqual(Array.from(result.drafts, (d) => d.key), [newer.key, older.key]);
  assert.ok(result.error);
  await client.recoverNoteDraft(foreign.key);
  client.discardNoteDraft(foreign.key);
  assert.deepEqual(requests, []);
  assert.deepEqual(storageEntries(storage), before);
  assert.equal(client.state.notes.body, "磁盘正文");
  const other = await noteClient(async () => ({}), undefined, { storage, dir: "/other/notes" });
  requireDraftFunctions(other, "readNoteDrafts");
  assert.deepEqual(Array.from(other.readNoteDrafts().drafts, (d) => d.key), [foreign.key]);
});

for (const action of ["读取失败", "取消", "期间输入", "成功"]) {
  test(`本地草稿：reload ${action}只在真正成功丢弃时清理自己的快照`, { timeout: 3000 }, async () => {
    const storage = memoryStorage();
    const history = seedDraft(storage, { body: "另一标签页" });
    const historyValue = storage.getItem(history.key);
    const started = gate();
    const release = gate();
    let reads = 0;
    const client = await noteClient(async () => {
      reads++;
      if (action === "读取失败") throw new Error("读取失败");
      if (action === "期间输入") { started.resolve(); await release.promise; }
      return noteResponse("磁盘新正文", "r9");
    }, () => action !== "取消", { storage });
    client.markNoteDirty();
    assert.equal(storage.length, 2, "历史草稿与自己的草稿分别保存");
    const before = storageEntries(storage);
    const reloading = client.reloadNote();
    try {
      if (action === "期间输入") {
        await started.promise;
        client.state.notes.body = "载入期间新增";
        client.markNoteDirty();
      }
    } finally {
      release.resolve();
      await reloading;
    }
    assert.equal(reads, action === "取消" ? 0 : 1);
    assert.equal(storage.getItem(history.key), historyValue);
    if (action === "成功") {
      assert.deepEqual(storageEntries(storage), [[history.key, historyValue]]);
      assert.equal(client.state.notes.body, "磁盘新正文");
      assert.equal(client.state.notes.dirty, false);
    } else {
      const own = storedDrafts(storage).find((d) => d.key !== history.key);
      assert.equal(own.body, action === "期间输入" ? "载入期间新增" : "第一段");
      assert.equal(own.baseRevision, "r1");
      assert.equal(client.state.notes.body, own.body);
      assert.equal(client.state.notes.dirty, true);
      if (action !== "期间输入") assert.deepEqual(storageEntries(storage), before);
    }
  });
}

test("本地草稿：discard 同步只删当前目录所选单条，不弹 confirm、不改服务器或编辑器", async () => {
  const storage = memoryStorage();
  const selected = seedDraft(storage);
  seedDraft(storage, { body: "另一份历史草稿" });
  const foreign = seedDraft(storage, { dir: "/other/notes" });
  storage.setItem("other-app-setting", "untouched");
  const requests = [];
  let prompts = 0;
  const client = await noteClient(async (path) => { requests.push(path); return {}; }, () => { prompts++; return false; }, { storage });
  requireDraftFunctions(client, "discardNoteDraft");
  client.markNoteDirty();
  const before = storageEntries(storage);
  const editor = editorDraft(client);
  const result = client.discardNoteDraft(selected.key);
  assert.notEqual(typeof result?.then, "function", "删除草稿应为同步操作");
  client.discardNoteDraft(foreign.key);
  client.discardNoteDraft("other-app-setting");
  client.discardNoteDraft(DRAFT_PREFIX + randomUUID());
  assert.equal(prompts, 0, "二次确认由 UI 而非原生 confirm 负责");
  assert.deepEqual(requests, []);
  assert.deepEqual(editorDraft(client), editor);
  assert.deepEqual(storageEntries(storage), before.filter(([key]) => key !== selected.key));
});

test("本地草稿：连续输入仅留最新所属快照，UUID 不复写，先写后删且不限制历史数量", async () => {
  const storage = memoryStorage();
  for (let i = 0; i < 120; i++) seedDraft(storage, { body: `历史 ${i}` });
  const history = storageEntries(storage);
  const writtenKeys = new Set(history.map(([key]) => key));
  const setItem = storage.setItem;
  const removeItem = storage.removeItem;
  const events = [];
  storage.setItem = (key, value) => {
    assert.match(key, /^localnote:draft:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.ok(!writtenKeys.has(key), "每个快照键只能写一次");
    writtenKeys.add(key);
    events.push(["set", key]);
    setItem(key, value);
  };
  storage.removeItem = (key) => { events.push(["remove", key]); removeItem(key); };
  const client = await noteClient(async () => ({}), undefined, { storage });
  let previous;
  for (let i = 0; i < 8; i++) {
    events.length = 0;
    client.state.notes.body = `输入 ${i}`;
    client.markNoteDirty();
    const own = storedDrafts(storage).filter((d) => !history.some(([key]) => key === d.key));
    assert.equal(own.length, 1, "同一编辑器只留下最新快照");
    assert.equal(own[0].body, `输入 ${i}`);
    assert.deepEqual(events, previous ? [["set", own[0].key], ["remove", previous]] : [["set", own[0].key]]);
    previous = own[0].key;
  }
  assert.equal(storage.length, 121, "不能通过草稿数量上限清理其它快照");
  for (const [key, value] of history) assert.equal(storage.getItem(key), value);
});

test("备份恢复：预览确认后生成独立副本，不修改在线数据", async () => {
  const listing = await ok("/api/backups");
  const date = listing.backups[0].date;
  const before = await readFile(file, "utf8");
  const preview = await ok(`/api/backups/${date}/preview`);
  assert.equal(preview.verified, true);
  assert.ok(preview.taskCount > 0);
  const restored = await ok(`/api/backups/${date}/recover`, { method: "POST", body: { fingerprint: preview.fingerprint } });
  assert.notEqual(restored.dir, notesDir);
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal(await readFile(join(restored.dir, "tasks.json"), "utf8"), await readFile(join(listing.dir, date, "tasks.json"), "utf8"));
  const stale = await call(`/api/backups/${date}/recover`, { method: "POST", body: { fingerprint: "0".repeat(64) } });
  assert.equal(stale.status, 409);
  const traversal = await call("/api/backups/..%2Ftasks.json/preview");
  assert.ok(traversal.status >= 400 && traversal.status < 500);
});

test("笔记 API：旧版本保存返回冲突且不覆盖正文", async () => {
  const original = await ok("/api/notes", { method: "POST", body: { title: "版本保护", body: "初稿" } });
  const id = original.note.id;
  const changed = await ok(`/api/notes/${id}`, { method: "PATCH", body: { body: "新正文", baseRevision: original.note.revision } });
  assert.notEqual(changed.note.revision, original.note.revision);
  const stale = await call(`/api/notes/${id}`, { method: "PATCH", body: { body: "陈旧覆盖", baseRevision: original.note.revision } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, "NOTE_CONFLICT");
  assert.equal((await ok(`/api/notes/${id}`)).body, "新正文");
});
