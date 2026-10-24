import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JsonStore, DEFAULT_SETTINGS } from "./lib/store.js";
import { seedIfEmpty } from "./lib/seed.js";
import {
  TaskError,
  applyTaskInput,
  buildTask,
  cleanTags,
  completeTask,
  dueReminders,
  newId,
  restoreTask,
  sortTasks,
  trashTask,
} from "./lib/tasks.js";
import { buildReview, buildStats } from "./lib/stats.js";
import { isValidTimeISO } from "./lib/time.js";
import { NotesLibrary } from "./lib/notes.js";
import { BackupManager } from "./lib/backup.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const DATA_FILE = process.env.TODO_DATA_FILE ? resolve(process.env.TODO_DATA_FILE) : join(ROOT, "data", "tasks.json");
const NOTES_DIR = process.env.TODO_NOTES_DIR ? resolve(process.env.TODO_NOTES_DIR) : join(ROOT, "notes");
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 8 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

const store = new JsonStore(DATA_FILE);
const notes = new NotesLibrary(NOTES_DIR);
const backups = new BackupManager({
  dataFile: DATA_FILE,
  notesDir: NOTES_DIR,
  backupsDir: process.env.TODO_BACKUP_DIR ? resolve(process.env.TODO_BACKUP_DIR) : join(dirname(DATA_FILE), "backups"),
});
store.onWrite = () => backups.snapshotIfStale();
notes.onWrite = () => backups.snapshotIfStale();

function download(res, name, text) {
  send(res, 200, text, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"`,
  });
}

function send(res, status, payload, headers = {}) {
  const body = typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((finish, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new TaskError("请求体过大", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return finish({});
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new TaskError("请求体不是合法 JSON", 400));
      }
    });
    req.on("error", reject);
  });
}

async function loadSeeded() {
  const data = await store.read();
  if (process.env.TODO_SEED === "1" && seedIfEmpty(data)) await store.save();
  return data;
}

function findTask(data, id) {
  const task = data.tasks.find((t) => t.id === id);
  if (!task) throw new TaskError("任务不存在", 404);
  return task;
}

function parentTagsOf(data, parentId) {
  if (!parentId) return "";
  return data.tasks.find((t) => t.id === parentId)?.tags?.join(",") ?? "";
}

function isDescendant(data, ancestorId, targetId) {
  const children = new Map();
  for (const task of data.tasks) {
    if (!task.parentId) continue;
    const list = children.get(task.parentId) ?? [];
    list.push(task.id);
    children.set(task.parentId, list);
  }
  const stack = [ancestorId];
  while (stack.length) {
    const id = stack.pop();
    if (id === targetId) return true;
    stack.push(...(children.get(id) ?? []));
  }
  return false;
}

async function handleApi(req, res, url) {
  const path = url.pathname;
  const now = new Date();
  const seg = path.split("/").filter(Boolean);
  const query = url.searchParams;

  if (req.method === "GET" && path === "/api/state") {
    const data = await loadSeeded();
    return send(res, 200, {
      now: now.toISOString(),
      settings: data.settings,
      projects: data.projects,
      tasks: sortTasks(data.tasks.filter((t) => t.status !== "trashed"), "smart", now, data.settings),
      trashed: sortTasks(data.tasks.filter((t) => t.status === "trashed"), "created", now, data.settings),
      reminders: dueReminders(data, now),
      tags: [...new Set(data.tasks.flatMap((t) => t.tags ?? []))].sort(),
    });
  }

  if (req.method === "GET" && path === "/api/stats") {
    const data = await loadSeeded();
    const days = Math.min(90, Math.max(7, Number(query.get("days")) || 14));
    return send(res, 200, buildStats(data, now, { days, projectId: query.get("projectId") || "" }));
  }

  if (req.method === "GET" && path === "/api/review") {
    const data = await loadSeeded();
    return send(res, 200, buildReview(data, now, {
      preset: query.get("preset") || "week",
      start: query.get("start") || "",
      end: query.get("end") || "",
      projectId: query.get("projectId") || "",
    }));
  }

  if (req.method === "GET" && path === "/api/reminders") {
    const data = await store.read();
    return send(res, 200, { now: now.toISOString(), reminders: dueReminders(data, now) });
  }

  if (req.method === "GET" && path === "/api/export") {
    const data = await store.read();
    return send(res, 200, JSON.stringify(data, null, 2), {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="tasks-${now.toISOString().slice(0, 10)}.json"`,
    });
  }

  if (req.method === "GET" && path === "/api/backups") {
    return send(res, 200, { dir: backups.backupsDir, keepDays: backups.keepDays, backups: await backups.list() });
  }
  if (seg[1] === "backups" && seg.length === 4) {
    const date = decodeURIComponent(seg[2]);
    if (req.method === "GET" && seg[3] === "preview") return send(res, 200, await backups.preview(date));
    if (req.method === "POST" && seg[3] === "recover") {
      if (req.headers.origin && req.headers.origin !== url.origin) throw new TaskError("不允许跨站恢复请求", 403);
      const body = await readBody(req);
      return send(res, 201, await backups.recover(date, body.fingerprint));
    }
  }

  if (seg[1] === "settings" && req.method === "POST") {
    const body = await readBody(req);
    const settings = await store.update((data) => {
      const s = data.settings;
      if (body.weekStart !== undefined) s.weekStart = [0, 1].includes(Number(body.weekStart)) ? Number(body.weekStart) : 1;
      if (body.dueEodTime !== undefined) s.dueEodTime = isValidTimeISO(body.dueEodTime) ? body.dueEodTime : DEFAULT_SETTINGS.dueEodTime;
      if (body.defaultRemindMinutes !== undefined) {
        const n = Number(body.defaultRemindMinutes);
        s.defaultRemindMinutes = Number.isFinite(n) ? Math.min(43_200, Math.max(0, Math.round(n))) : 0;
      }
      if (body.reminderPollSeconds !== undefined) {
        const n = Number(body.reminderPollSeconds);
        s.reminderPollSeconds = Number.isFinite(n) ? Math.min(600, Math.max(10, Math.round(n))) : DEFAULT_SETTINGS.reminderPollSeconds;
      }
      return s;
    });
    return send(res, 200, { settings });
  }

  if (seg[1] === "projects") {
    if (req.method === "POST" && seg.length === 2) {
      const body = await readBody(req);
      const name = String(body.name ?? "").trim().slice(0, 40);
      if (!name) throw new TaskError("项目名称不能为空");
      const project = await store.update((data) => {
        if (data.projects.some((p) => p.name === name)) throw new TaskError("该项目已存在");
        const created = {
          id: newId("p"),
          name,
          color: /^#[0-9a-fA-F]{6}$/.test(body.color ?? "") ? body.color : "#5b6b7f",
          createdAt: now.toISOString(),
        };
        data.projects.push(created);
        return created;
      });
      return send(res, 201, { project });
    }

    const id = seg[2];
    if (!id) throw new TaskError("缺少项目 id", 404);

    if (req.method === "PATCH") {
      const body = await readBody(req);
      const project = await store.update((data) => {
        const found = data.projects.find((p) => p.id === id);
        if (!found) throw new TaskError("项目不存在", 404);
        if (body.name !== undefined) {
          const name = String(body.name).trim().slice(0, 40);
          if (!name) throw new TaskError("项目名称不能为空");
          if (data.projects.some((p) => p.name === name && p.id !== id)) throw new TaskError("项目名称重复");
          found.name = name;
        }
        if (body.color !== undefined && /^#[0-9a-fA-F]{6}$/.test(body.color)) found.color = body.color;
        return found;
      });
      return send(res, 200, { project });
    }

    if (req.method === "DELETE") {
      const result = await store.update((data) => {
        if (!data.projects.some((p) => p.id === id)) throw new TaskError("项目不存在", 404);
        data.projects = data.projects.filter((p) => p.id !== id);
        let moved = 0;
        for (const task of data.tasks) {
          if (task.projectId === id) {
            task.projectId = null;
            moved += 1;
          }
        }
        return { moved };
      });
      return send(res, 200, result);
    }
  }

  if (seg[1] === "notes") {
    const filter = { q: query.get("q") || "", tag: query.get("tag") || "", pinned: query.get("pinned") || "" };

    if (seg.length === 2 && req.method === "GET") {
      const result = await notes.list(filter);
      return send(res, 200, { ...result, dir: notes.dir, trashCount: (await notes.listTrash()).length });
    }
    if (seg.length === 2 && req.method === "POST") {
      const entry = await notes.create(await readBody(req));
      return send(res, 201, { note: entry.note, body: entry.body });
    }
    if (seg[2] === "export" && seg[3] === "all" && req.method === "GET") {
      const file = await notes.exportAll(filter);
      return download(res, file.name, file.text);
    }
    if (seg[2] === "import" && req.method === "POST") {
      const body = await readBody(req);
      return send(res, 200, await notes.importMany(Array.isArray(body.files) ? body.files : []));
    }
    if (seg[2] === "clips" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.title && !body.url && !body.text) throw new TaskError("剪藏内容为空");
      const result = await notes.appendClip({
        noteTitle: body.note,
        title: body.title,
        url: body.url,
        text: body.text,
        image: body.image,
      }, now);
      return send(res, 201, { note: result.note, created: result.created, dir: notes.dir });
    }

    // 回收站路由要放在通用 id 之前；名为 trash 的笔记仍可用它的 n_ id 访问
    if (seg[2] === "trash") {
      if (req.method === "GET" && seg.length === 3) return send(res, 200, { items: await notes.listTrash() });
      const trashId = decodeURIComponent(seg[3] ?? "");
      if (!trashId) throw new TaskError("缺少回收站条目", 404);
      if (seg[4] === "restore" && req.method === "POST") {
        const entry = await notes.restoreTrash(trashId);
        return send(res, 200, { note: entry.note, body: entry.body });
      }
      if (seg[4] === "purge" && req.method === "POST") return send(res, 200, await notes.purgeTrash(trashId));
      throw new TaskError(`未知接口: ${req.method} ${path}`, 404);
    }

    const id = decodeURIComponent(seg[2]);
    if (!id) throw new TaskError("缺少笔记 id", 404);

    if (seg[3] === "history") {
      if (seg.length === 4 && req.method === "GET") return send(res, 200, await notes.listHistory(id));
      const revision = decodeURIComponent(seg[4] ?? "");
      if (seg.length === 5 && req.method === "GET") return send(res, 200, await notes.getHistory(id, revision));
      if (seg.length === 6 && seg[5] === "restore" && req.method === "POST") {
        const body = await readBody(req);
        const entry = await notes.restoreHistory(id, revision, body.baseRevision);
        return send(res, 200, { note: entry.note, body: entry.body });
      }
      throw new TaskError(`未知接口: ${req.method} ${path}`, 404);
    }

    if (seg[3] === "export" && req.method === "GET") {
      const file = await notes.exportOne(id);
      return download(res, file.name, file.text);
    }
    if (req.method === "GET") return send(res, 200, await notes.get(id));
    if (req.method === "PATCH") {
      const entry = await notes.update(id, await readBody(req));
      return send(res, 200, { note: entry.note, body: entry.body });
    }
    if (req.method === "DELETE") return send(res, 200, await notes.remove(id));
  }

  if (seg[1] === "tasks") {
    if (req.method === "POST" && seg.length === 2) {
      const body = await readBody(req);
      const task = await store.update(async (data) => {
        const created = buildTask(body, now);
        if (created.sourceNoteId) created.sourceNoteId = (await notes.get(created.sourceNoteId)).note.id;
        if (created.parentId) {
          const parent = data.tasks.find((t) => t.id === created.parentId);
          if (!parent) throw new TaskError("父任务不存在");
          if (!created.projectId) created.projectId = parent.projectId;
          if (!created.due && parent.due) created.due = parent.due;
          if (!created.tags.length) created.tags = cleanTags(parentTagsOf(data, created.parentId));
        }
        data.tasks.push(created);
        return created;
      });
      return send(res, 201, { task, reminders: dueReminders(await store.read(), now) });
    }

    const id = seg[2];
    if (!id) throw new TaskError("缺少任务 id", 404);
    const action = seg[3];

    if (!action && req.method === "GET") {
      const data = await store.read();
      return send(res, 200, { task: findTask(data, id) });
    }

    if (req.method === "PATCH") {
      const body = await readBody(req);
      const task = await store.update(async (data) => {
        const found = findTask(data, id);
        const sourceNoteIdBefore = found.sourceNoteId;
        const next = { ...body };
        delete next.id;
        if (next.status === "trashed") throw new TaskError("请使用删除操作移入回收站");
        if (next.parentId) {
          if (next.parentId === id) throw new TaskError("父任务不能是自己");
          if (isDescendant(data, id, next.parentId)) throw new TaskError("不能把任务挂到自己的子任务下");
        }
        const scheduleTouched = ["due", "dueTime", "remindMinutes"].some((key) => key in body);
        applyTaskInput(found, next, { creating: false });
        if (found.sourceNoteId && found.sourceNoteId !== sourceNoteIdBefore) {
          found.sourceNoteId = (await notes.get(found.sourceNoteId)).note.id;
        }
        if (found.status === "done" && !found.completedAt) found.completedAt = now.toISOString();
        if (found.status !== "done") found.completedAt = null;
        if (scheduleTouched) found.reminderDismissedAt = null;
        found.updatedAt = now.toISOString();
        return found;
      });
      return send(res, 200, { task, reminders: dueReminders(await store.read(), now) });
    }

    if (action === "complete" && req.method === "POST") {
      const body = await readBody(req);
      const done = body.done === undefined ? true : Boolean(body.done);
      const result = await store.update((data) => completeTask(data, id, done, now));
      return send(res, 200, { ...result, reminders: dueReminders(await store.read(), now) });
    }

    if (action === "trash" && req.method === "POST") {
      const result = await store.update((data) => trashTask(data, id, now));
      return send(res, 200, result);
    }

    if (action === "restore" && req.method === "POST") {
      const result = await store.update((data) => restoreTask(data, id, now));
      return send(res, 200, result);
    }

    if (action === "purge" && req.method === "POST") {
      const result = await store.update((data) => trashTask(data, id, now, true));
      return send(res, 200, result);
    }

    if (action === "reminder" && req.method === "POST") {
      const body = await readBody(req);
      const task = await store.update((data) => {
        const found = findTask(data, id);
        if (body.action === "snooze") {
          const minutes = Math.min(1440, Math.max(1, Number(body.minutes) || 30));
          found.snoozedUntil = new Date(now.getTime() + minutes * 60_000).toISOString();
        } else {
          found.reminderDismissedAt = now.toISOString();
        }
        found.updatedAt = now.toISOString();
        return found;
      });
      return send(res, 200, {
        task: { id: task.id, snoozedUntil: task.snoozedUntil, reminderDismissedAt: task.reminderDismissedAt },
        reminders: dueReminders(await store.read(), now),
      });
    }
  }

  throw new TaskError(`未知接口: ${req.method} ${path}`, 404);
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = normalize(join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
    send(res, 403, { error: "禁止访问" });
    return;
  }
  try {
    const file = await readFile(target);
    res.writeHead(200, { "Content-Type": MIME[extname(target)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : file);
    return;
  } catch {
    /* 落到 index.html */
  }
  if (extname(target)) {
    send(res, 404, { error: "文件不存在" });
    return;
  }
  try {
    const index = await readFile(join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : index);
  } catch {
    send(res, 500, { error: "缺少 public/index.html" });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, { error: "方法不允许" });
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    if (status >= 500) console.error("[todo]", error);
    if (!res.headersSent) send(res, status, { error: error.message ?? "服务器内部错误", code: error.code });
  }
});

await loadSeeded();

if (process.env.TODO_NO_LISTEN !== "1") {
  server.listen(PORT, HOST, () => {
    console.log(`本地任务管理系统: http://${HOST}:${PORT}`);
    console.log(`  任务数据: ${DATA_FILE}`);
    console.log(`  笔记目录: ${NOTES_DIR}`);
  });
}

export { DATA_FILE, NOTES_DIR, server, store };
