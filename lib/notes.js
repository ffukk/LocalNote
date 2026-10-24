import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

import { newId } from "./tasks.js";

export class NotesError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)*/;
const ILLEGAL_IN_NAME = /[\\/:*?"<>|\x00-\x1f]/g;
// Windows 只禁止 \ / : * ? " < > | 与控制字符；这里额外保留中文、全角标点与常用文件名安全符号，
// 让「会议记录（改）」这类标题不被压成「会议记录-改」。
const UNSAFE_IN_NAME = /[^0-9A-Za-z_\-. \u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff01-\uff5e ()[\]{}+#=@%&'~!^$]/g;

const trim = (value, max) => String(value ?? "").trim().slice(0, max);

/** 标题 -> 文件名主干：去掉非法字符，保留中文/字母/数字/下划线/短横线。 */
export function slugTitle(title, fallback = "note") {
  const cleaned = trim(title, 80)
    .replace(ILLEGAL_IN_NAME, "-")
    .replace(UNSAFE_IN_NAME, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "");
  return cleaned || fallback;
}

function uniqueStrings(list) {
  return [...new Set(list)].slice(0, 20);
}

export function parseTags(value) {
  if (Array.isArray(value)) return uniqueStrings(value.map((v) => trim(v, 24)).filter(Boolean));
  const text = trim(value, 300);
  if (!text) return [];
  const inner = text.trim().startsWith("[") && text.trim().endsWith("]") ? text.trim().slice(1, -1) : text;
  return uniqueStrings(
    inner
      .split(/[,，;；\n\s]+/)
      .map((t) => trim(t.replace(/^["']|["']$/g, ""), 24))
      .filter(Boolean)
  );
}

function parseIso(value) {
  const text = trim(value, 40);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** 解析 YAML 风格 front matter（只支持单层 key: value，够用且不引依赖）。 */
export function parseFrontMatter(text) {
  const match = FRONT_MATTER_RE.exec(String(text ?? ""));
  if (!match) return { meta: null, body: String(text ?? "") };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (key === "tags") meta.tags = parseTags(raw);
    else if (key === "pinned") meta.pinned = raw === "true";
    else if (key === "createdAt" || key === "updatedAt") meta[key] = parseIso(raw);
    else meta[key] = raw.replace(/^["']|["']$/g, "");
  }
  return { meta, body: match.input.slice(match[0].length) };
}

export function serializeNote(meta, body) {
  const head = [
    "---",
    `id: ${meta.id}`,
    `title: ${meta.title ?? ""}`,
    `tags: [${(meta.tags ?? []).join(", ")}]`,
    `pinned: ${meta.pinned ? "true" : "false"}`,
    `createdAt: ${meta.createdAt ?? new Date().toISOString()}`,
    `updatedAt: ${meta.updatedAt ?? new Date().toISOString()}`,
    "---",
    "",
  ];
  return `${head.join("\n")}\n${String(body ?? "").replace(/\r\n/g, "\n")}`;
}

/** 标题推断：一级标题 > 首个非空正文行 > 文件名。 */
export function inferTitle(body, fileName) {
  const text = String(body ?? "");
  const heading = /^\s*#\s+(.+)$/m.exec(text);
  if (heading) return trim(heading[1], 120);
  const firstLine = text.split(/\r?\n/).find((line) => line.trim());
  if (firstLine) return trim(firstLine.replace(/^[>*\-#]+\s*/, ""), 120);
  return trim(basename(String(fileName ?? ""), ".md"), 120) || "无标题";
}

export function plainExcerpt(body, length = 120) {
  return String(body ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, length);
}

function bodyHitExcerpt(body, keyword) {
  const at = body.toLowerCase().indexOf(keyword);
  if (at < 0) return null;

  // 小写转换可能展开字符（如 İ）；将小写串的 UTF-16 偏移映射回原文，且不切断代理对。
  let foldedOffset = 0;
  let start = 0;
  let end = 0;
  for (const char of body) {
    if (foldedOffset <= at) start = end;
    end += char.length;
    foldedOffset += char.toLowerCase().length;
    if (foldedOffset >= at + keyword.length) break;
  }

  const before = Array.from(body.slice(0, start).replace(/\s+/g, " "));
  const hit = body.slice(start, end);
  const after = Array.from(body.slice(end).replace(/\s+/g, " "));
  return `${before.length > 40 ? "…" : ""}${before.slice(-40).join("")}${hit}${after.slice(0, 140).join("")}${after.length > 140 ? "…" : ""}`;
}

/** 字数统计：中文按字符、英文数字按词。 */
export function countWords(body) {
  const text = String(body ?? "");
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z0-9_'-]+/g) ?? []).length;
  return cjk + latin;
}

/** 比对用正文：忽略与标题重复的首行一级标题与空白差异。 */
function comparableBody(text, title) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const first = lines[0]?.replace(/^\s*#\s*/, "").trim();
  if (first && first === String(title ?? "").trim()) lines.shift();
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

/** 剪藏内容消毒：去掉控制字符、压缩空白、限制长度，避免一条剪藏撑爆笔记。 */
function cleanClip(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim()
    .slice(0, max);
}

/** 一条剪藏的 Markdown 片段；正文按引用块逐行加前缀，防止粘贴内容打断结构。 */
export function clipBlock({ title, url = "", text = "", image = "" }, at = new Date()) {
  const heading = cleanClip(title, 120) || cleanClip(url, 120) || "未命名页面";
  const stamp = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const lines = [`### ${heading.replace(/#/g, "\\#")}`, "", `- 时间：${stamp}`];
  if (url) lines.push(`- 来源：<${cleanClip(url, 500).replace(/[>\n]/g, "")}>`);
  if (image) lines.push(`- 图片：<${cleanClip(image, 500).replace(/[>\n]/g, "")}>`);
  const body = cleanClip(text, 2000);
  if (body) {
    lines.push("", ...body.split("\n").map((line) => `> ${line}`));
  }
  return lines.join("\n");
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validRevision = (value) => typeof value === "string" && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
const historyError = (message) => new NotesError(`笔记历史${message}`, 409);

function requireRevision(value, name = "revision") {
  if (!validRevision(value)) throw new NotesError(`缺少或无效的历史 ${name}，须为小写 SHA256`, 400);
}

async function historyStat(path) {
  return lstat(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
}

// 从根向下检查，不能先读取链接祖先之下的路径；Windows junction 同样被 lstat 拒绝。
async function historyDirectory(path, create = false) {
  const parents = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    parents.push(current);
    if (dirname(current) === current) break;
  }
  for (const current of parents.reverse()) {
    let info = await historyStat(current);
    if (!info && create) {
      await mkdir(current).catch((error) => { if (error.code !== "EEXIST") throw error; });
      info = await lstat(current);
    }
    if (!info) return false;
    if (info.isSymbolicLink() || !info.isDirectory()) throw historyError("目录不允许链接或非目录路径");
  }
  return true;
}

async function readHistoryFile(path, noteId, revision) {
  if (!(await historyDirectory(dirname(path)))) return null;
  const before = await historyStat(path);
  if (!before) return null;
  if (before.isSymbolicLink() || !before.isFile()) throw historyError("仅允许普通文件，不允许链接");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let bytes;
  let info;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw historyError("文件在读取时被替换");
    bytes = await handle.readFile();
    info = await handle.stat();
    await historyDirectory(dirname(path));
    const current = await historyStat(path);
    if (!current?.isFile() || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino ||
        opened.size !== info.size || opened.mtimeMs !== info.mtimeMs || opened.ctimeMs !== info.ctimeMs || bytes.length !== info.size) {
      throw historyError("文件在读取时被修改");
    }
  } finally {
    await handle.close();
  }
  if (digest(bytes) !== revision) throw historyError("内容校验失败，请勿使用损坏的版本");
  const { meta, body } = parseFrontMatter(bytes.toString("utf8"));
  if (meta && Object.hasOwn(meta, "id") && meta.id !== noteId) throw historyError("笔记 ID 不匹配");
  return {
    bytes,
    body,
    version: {
      revision,
      savedAt: info.mtime.toISOString(), // 留存文件的时间，而非旧稿 front matter 的更新时间。
      title: trim(meta?.title, 120) || inferTitle(body, "无标题"),
      tags: meta?.tags ?? [],
      pinned: Boolean(meta?.pinned),
      updatedAt: meta?.updatedAt ?? info.mtime.toISOString(),
      words: countWords(body),
    },
  };
}

/** 笔记库：notes/ 下一个 .md 文件即一条笔记，外部编辑器改完刷新即可见。 */
export class NotesLibrary {
  #queue = Promise.resolve();

  constructor(dir) {
    this.dir = resolve(dir);
    /** 落盘前的钩子（自动备份用），由 server 注入；钩子直接读取磁盘，勿重入本库队列。 */
    this.onWrite = null;
  }

  // 读也入队，避免看见改名/恢复等操作的中间状态；内部只调用私有实现。
  #enqueue(run) {
    const pending = this.#queue.then(run);
    this.#queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  #safePath(name) {
    const clean = basename(String(name), ".md")
      .replace(ILLEGAL_IN_NAME, "")
      .replace(UNSAFE_IN_NAME, "-")
      .replace(/^[-. ]+/g, "")
      .replace(/[-. ]+$/g, "")
      .slice(0, 120);
    if (!clean || clean === "." || clean === "..") throw new NotesError("非法的笔记文件名");
    const full = resolve(join(this.dir, `${clean}.md`));
    if (!full.startsWith(this.dir + sep)) throw new NotesError("非法的笔记路径", 403);
    return full;
  }

  async #files() {
    await mkdir(this.dir, { recursive: true });
    const names = await readdir(this.dir);
    return names.filter((f) => extname(f).toLowerCase() === ".md" && !basename(f).startsWith("_") && !basename(f).startsWith("."));
  }

  async #readEntry(file) {
    const full = this.#safePath(file);
    const [bytes, info] = await Promise.all([readFile(full), stat(full)]);
    const raw = bytes.toString("utf8");
    const { meta, body } = parseFrontMatter(raw);
    const fileStem = basename(file, ".md");
    const note = {
      id: trim(meta?.id, 160) || fileStem,
      revision: createHash("sha256").update(bytes).digest("hex"),
      file: fileStem,
      title: trim(meta?.title, 120) || inferTitle(body, file),
      tags: meta?.tags ?? [],
      pinned: Boolean(meta?.pinned),
      createdAt: meta?.createdAt ?? info.birthtime.toISOString(),
      updatedAt: meta?.updatedAt ?? info.mtime.toISOString(),
      words: countWords(body),
    };
    return { note, body, path: full, raw, bytes };
  }

  async #all() {
    const files = await this.#files();
    const entries = await Promise.all(
      files.map((file) =>
        this.#readEntry(file).catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        })
      )
    );
    return entries.filter(Boolean);
  }

  #match(entries, { q, tag, pinned }) {
    const keyword = trim(q, 80).toLowerCase();
    const matched = [];
    for (const entry of entries) {
      const note = { ...entry.note, excerpt: plainExcerpt(entry.body) };
      if (tag && !note.tags.includes(tag)) continue;
      if (pinned === "1" && !note.pinned) continue;
      if (pinned === "0" && note.pinned) continue;
      if (keyword) {
        const haystack = `${note.title} ${note.tags.join(" ")} ${entry.body}`.toLowerCase();
        const at = haystack.indexOf(keyword);
        if (at < 0) continue;
        note.hit = bodyHitExcerpt(entry.body, keyword) ?? note.excerpt;
      }
      matched.push({ note, body: entry.body });
    }
    matched.sort((a, b) => Number(b.note.pinned) - Number(a.note.pinned) || String(b.note.updatedAt).localeCompare(String(a.note.updatedAt)));
    return matched;
  }

  list(filter = {}) {
    return this.#enqueue(() => this.#list(filter));
  }

  async #list(filter) {
    const matched = this.#match(await this.#all(), filter);
    return {
      notes: matched.map((m) => m.note),
      tags: [...new Set(matched.flatMap((m) => m.note.tags))].sort(),
      total: matched.length,
    };
  }

  async #require(id) {
    const wanted = trim(id, 160);
    if (!wanted) throw new NotesError("缺少笔记 id", 404);
    const entry = (await this.#all()).find((e) => e.note.id === wanted || e.note.file === wanted);
    if (!entry) throw new NotesError("笔记不存在", 404);
    return entry;
  }

  get(id) {
    return this.#enqueue(() => this.#get(id));
  }

  async #get(id) {
    const entry = await this.#require(id);
    return { note: entry.note, body: entry.body };
  }

  async #uniqueName(base, ownerId) {
    const root = String(base || "note").slice(0, 100);
    for (let i = 1; i <= 200; i += 1) {
      const candidate = i === 1 ? root : `${root}-${i}`;
      const full = this.#safePath(candidate);
      let occupant = null;
      try {
        const raw = await readFile(full, "utf8");
        occupant = trim(parseFrontMatter(raw).meta?.id, 160) || candidate;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!occupant || (ownerId && occupant === ownerId)) return candidate;
    }
    throw new NotesError("同名笔记过多，无法分配文件名", 500);
  }

  async #checkWrite(path, sourceEntry) {
    if (sourceEntry) {
      const bytes = await readFile(sourceEntry.path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (bytes === null || digest(bytes) !== sourceEntry.note.revision) {
        throw new NotesError("笔记版本冲突，请保留当前草稿，重新读取最新版本后再保存", 409, "NOTE_CONFLICT");
      }
    }
    if (path !== sourceEntry?.path) {
      const target = await stat(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (target) throw new NotesError("笔记版本冲突，目标文件已被占用，请保留草稿后重试", 409, "NOTE_CONFLICT");
    }
  }

  async #write(path, text, sourceEntry = null) {
    // 先让备份拿到「写入前」的磁盘状态，再落新内容和单篇历史；钩子不能重入队列。
    if (this.onWrite) await this.onWrite();
    await mkdir(this.dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, text, "utf8");
      if (sourceEntry) {
        await this.#checkWrite(path, sourceEntry);
        await this.#archive(sourceEntry);
      }
      for (let attempt = 0; ; attempt += 1) {
        // 备份、归档、临时写入及重试期间都可能被外部编辑；这不是原子 CAS。
        await this.#checkWrite(path, sourceEntry);
        try {
          await rename(tmp, path);
          return;
        } catch (error) {
          if (error.code !== "EPERM" || attempt >= 4) {
            if (error.code === "EPERM") throw new NotesError("笔记文件被其它程序占用，请关闭编辑器后重试", 409);
            throw error;
          }
          await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
        }
      }
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }

  create(input = {}) {
    return this.#enqueue(() => this.#create(input));
  }

  async #create(input) {
    const body = String(input.body ?? "");
    const title = trim(input.title, 120) || inferTitle(body, "无标题");
    const id = trim(input.id, 160) || newId("n");
    const now = new Date().toISOString();
    const meta = {
      id,
      title,
      tags: parseTags(input.tags),
      pinned: Boolean(input.pinned),
      createdAt: parseIso(input.createdAt) ?? now,
      updatedAt: parseIso(input.updatedAt) ?? now,
    };
    const path = this.#safePath(await this.#uniqueName(slugTitle(title, id), null));
    await this.#write(path, serializeNote(meta, body));
    return this.#readEntry(basename(path));
  }

  update(id, patch = {}) {
    return this.#enqueue(() => this.#update(id, patch));
  }

  async #update(id, patch) {
    await historyDirectory(this.dir);
    const entry = await this.#require(id);
    if (patch.baseRevision !== undefined && patch.baseRevision !== entry.note.revision) {
      throw new NotesError("笔记版本冲突，请保留当前草稿，重新读取最新版本后再保存", 409, "NOTE_CONFLICT");
    }
    const body = patch.body !== undefined ? String(patch.body) : entry.body;
    const title = patch.title !== undefined ? trim(patch.title, 120) || inferTitle(body, entry.note.file) : entry.note.title;
    const meta = {
      id: entry.note.id,
      title,
      tags: patch.tags !== undefined ? parseTags(patch.tags) : entry.note.tags,
      pinned: patch.pinned !== undefined ? Boolean(patch.pinned) : entry.note.pinned,
      createdAt: entry.note.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (body === entry.body && title === entry.note.title && meta.pinned === entry.note.pinned &&
        JSON.stringify(meta.tags) === JSON.stringify(entry.note.tags)) return entry;
    const wanted = slugTitle(title, meta.id);
    const name = wanted === entry.note.file ? entry.note.file : await this.#uniqueName(wanted, meta.id);
    let path = this.#safePath(name);
    if (path !== entry.path) {
      try {
        const [source, target] = await Promise.all([stat(entry.path, { bigint: true }), stat(path, { bigint: true })]);
        // 大小写是否敏感由目录决定；实际为同文件时保留原名，避免 unlink 删掉新稿。
        if (source.dev === target.dev && source.ino === target.ino) path = entry.path;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await this.#write(path, serializeNote(meta, body), entry);
    if (path !== entry.path) {
      try {
        await unlink(entry.path);
      } catch (error) {
        if (error.code !== "ENOENT") {
          // 新路径尚未对队列外的读取发布；失败时撤回，保留唯一旧原稿。
          await unlink(path);
          throw error;
        }
      }
    }
    return this.#readEntry(basename(path));
  }

  #historyDir(noteId) {
    return join(this.dir, "_history", digest(noteId));
  }

  async #archive(entry) {
    const { id, revision } = entry.note;
    if (digest(entry.bytes) !== revision) throw historyError("原稿字节校验失败");
    const dir = this.#historyDir(id);
    await historyDirectory(dir, true);
    const path = join(dir, `${revision}.md`);
    if (await readHistoryFile(path, id, revision)) return;
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let owned = true;
    try {
      await writeFile(tmp, entry.bytes, { flag: "wx" }).catch((error) => {
        if (error.code === "EEXIST") owned = false;
        throw error;
      });
      if (!(await readHistoryFile(tmp, id, revision))) throw historyError("临时文件丢失");
      await historyDirectory(dir);
      // hard link 独占、原子发布完整文件；rename 在 POSIX 会覆写已存在的同名历史。
      await link(tmp, path).catch((error) => { if (error.code !== "EEXIST") throw error; });
      if (!(await readHistoryFile(path, id, revision))) throw historyError("发布文件丢失");
    } finally {
      // 不清理其它历史/临时文件，失败写入留下的完整旧稿仍可重用。
      if (owned && await historyDirectory(dir)) await unlink(tmp).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  }

  listHistory(id) {
    return this.#enqueue(() => this.#listHistory(id));
  }

  async #listHistory(id) {
    await historyDirectory(this.dir);
    const entry = await this.#require(id);
    const dir = this.#historyDir(entry.note.id);
    const versions = [];
    if (await historyDirectory(dir)) {
      for (const name of await readdir(dir)) {
        const path = join(dir, name);
        const info = await historyStat(path);
        if (!info) continue;
        if (info.isSymbolicLink() || !info.isFile()) throw historyError("目录包含链接或非普通文件");
        if (name.endsWith(".tmp")) continue;
        const revision = name.slice(0, -3);
        if (!name.endsWith(".md") || !validRevision(revision)) throw historyError("文件名格式无效");
        const old = await readHistoryFile(path, entry.note.id, revision);
        // 归档完成但正文写入失败时，不能把仍然在线的 revision 冒充已发生的变化。
        if (old && revision !== entry.note.revision) versions.push(old.version);
      }
    }
    versions.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.revision.localeCompare(b.revision));
    return { noteId: entry.note.id, currentRevision: entry.note.revision, versions };
  }

  async #historyVersion(noteId, revision) {
    requireRevision(revision);
    const old = await readHistoryFile(join(this.#historyDir(noteId), `${revision}.md`), noteId, revision);
    if (!old) throw new NotesError("笔记历史版本不存在", 404);
    return old;
  }

  getHistory(id, revision) {
    return this.#enqueue(async () => {
      await historyDirectory(this.dir);
      const entry = await this.#require(id);
      const { version, body } = await this.#historyVersion(entry.note.id, revision);
      return { noteId: entry.note.id, version, body };
    });
  }

  restoreHistory(id, revision, baseRevision) {
    return this.#enqueue(async () => {
      await historyDirectory(this.dir);
      const entry = await this.#require(id);
      requireRevision(baseRevision, "baseRevision");
      if (baseRevision !== entry.note.revision) {
        throw new NotesError("笔记版本冲突，请保留当前草稿，重新读取最新版本后再保存", 409, "NOTE_CONFLICT");
      }
      const { version, body } = await this.#historyVersion(entry.note.id, revision);
      // 私有更新重新读当前稿并检查 baseRevision；不复用旧 revision、id 或创建时间。
      return this.#update(entry.note.id, { title: version.title, tags: version.tags, pinned: version.pinned, body, baseRevision });
    });
  }

  #trashDir() {
    return join(this.dir, "_trash");
  }

  #trashName(originalFile, at) {
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
    return `${stamp}-${randomUUID()}__${originalFile}.md`;
  }

  /** 删除 = 移入 notes/_trash/（库本身忽略 _ 开头的目录），超期自动清理。 */
  remove(id, at = new Date()) {
    return this.#enqueue(() => this.#remove(id, at));
  }

  async #remove(id, at) {
    const entry = await this.#require(id);
    if (this.onWrite) await this.onWrite();
    await mkdir(this.#trashDir(), { recursive: true });
    const target = join(this.#trashDir(), this.#trashName(entry.note.file, at));
    await rename(entry.path, target);
    await this.#pruneTrash(at, 7);
    return { removed: entry.note.id, file: entry.note.file, title: entry.note.title, trash: basename(target) };
  }

  async #trashEntries() {
    let names;
    try {
      names = await readdir(this.#trashDir());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return [];
    }
    return names
      .filter((n) => n.endsWith(".md"))
      .map((n) => {
        const match = /^(\d{8})-(\d{6})(?:-[0-9a-f-]+)?__(.+)\.md$/.exec(n);
        const deletedAt = match
          ? new Date(
              `${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)}T${match[2].slice(0, 2)}:${match[2].slice(2, 4)}:${match[2].slice(4, 6)}`
            ).toISOString()
          : null;
        return { name: n, original: match ? match[3] : n.replace(/\.md$/, ""), deletedAt };
      })
      .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  }

  listTrash() {
    return this.#enqueue(() => this.#listTrash());
  }

  async #listTrash() {
    const entries = await this.#trashEntries();
    const items = [];
    for (const item of entries) {
      const bytes = await readFile(join(this.#trashDir(), item.name)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (bytes === null) continue;
      const { meta, body } = parseFrontMatter(bytes.toString("utf8"));
      items.push({
        id: trim(meta?.id, 160) || item.original,
        revision: createHash("sha256").update(bytes).digest("hex"),
        trashFile: item.name,
        originalFile: item.original,
        title: trim(meta?.title, 120) || inferTitle(body, item.original),
        tags: meta?.tags ?? [],
        deletedAt: item.deletedAt,
        words: countWords(body),
      });
    }
    return items;
  }

  restoreTrash(id) {
    return this.#enqueue(() => this.#restoreTrash(id));
  }

  async #restoreTrash(id) {
    const wanted = trim(id, 240);
    const entries = await this.#trashEntries();
    let hit = entries.find((e) => e.original === wanted || e.name === wanted);
    if (!hit) {
      const byId = (await this.#listTrash()).find((i) => i.id === wanted);
      hit = entries.find((e) => e.name === byId?.trashFile);
    }
    if (!hit) throw new NotesError("回收站里没有这条笔记", 404);
    const source = join(this.#trashDir(), hit.name);
    const { meta } = parseFrontMatter(await readFile(source, "utf8"));
    const restoredId = trim(meta?.id, 160) || hit.original;
    if ((await this.#all()).some((entry) => entry.note.id === restoredId)) {
      throw new NotesError("已存在相同 id 的笔记，请先处理现有笔记再恢复", 409);
    }
    const name = await this.#uniqueName(hit.original, null);
    const path = this.#safePath(name);
    if (this.onWrite) await this.onWrite();
    await rename(source, path);
    return this.#readEntry(basename(path));
  }

  purgeTrash(id) {
    return this.#enqueue(() => this.#purgeTrash(id));
  }

  async #purgeTrash(id) {
    const entries = await this.#trashEntries();
    const hit = entries.find((e) => e.name === id || e.original === id);
    if (!hit) throw new NotesError("回收站里没有这条笔记", 404);
    if (this.onWrite) await this.onWrite();
    await unlink(join(this.#trashDir(), hit.name));
    return { purged: hit.name };
  }

  /** 清理超过保留天数的回收站文件；只认带时间戳前缀的文件名。 */
  pruneTrash(at = new Date(), keepDays = 7) {
    return this.#enqueue(() => this.#pruneTrash(at, keepDays));
  }

  async #pruneTrash(at, keepDays) {
    const cutoff = at.getTime() - keepDays * 86_400_000;
    const removed = [];
    for (const item of await this.#trashEntries()) {
      if (!item.deletedAt || new Date(item.deletedAt).getTime() >= cutoff) continue;
      if (this.onWrite) await this.onWrite();
      await unlink(join(this.#trashDir(), item.name));
      removed.push(item.name);
    }
    return removed;
  }

  /** 浏览器剪藏：追加到指定标题的笔记，笔记不存在时创建。 */
  appendClip(input = {}, at = new Date()) {
    return this.#enqueue(() => this.#appendClip(input, at));
  }

  async #appendClip(input, at) {
    const wanted = trim(input.noteTitle, 80) || "网页剪藏";
    const block = clipBlock(input, at);
    const existing = (await this.#all()).find((e) => e.note.title === wanted);
    if (!existing) {
      const header = `# ${wanted}\n\n由浏览器扩展剪藏，最新内容追加在最后。\n\n---`;
      const entry = await this.#create({
        title: wanted,
        body: `${header}\n\n${block}\n`,
        tags: ["剪藏"],
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
      });
      return { note: entry.note, created: true };
    }
    const body = `${existing.body.replace(/\s+$/, "")}\n\n${block}\n`;
    const entry = await this.#update(existing.note.id, { body, baseRevision: existing.note.revision });
    return { note: entry.note, created: false };
  }

  exportOne(id) {
    return this.#enqueue(() => this.#exportOne(id));
  }

  async #exportOne(id) {
    const entry = await this.#require(id);
    return { name: `${entry.note.file}.md`, text: entry.raw };
  }

  /** 合并导出为单份 Markdown（带目录），避免引入压缩依赖。 */
  exportAll(filter = {}) {
    return this.#enqueue(() => this.#exportAll(filter));
  }

  async #exportAll(filter) {
    const matched = this.#match(await this.#all(), filter);
    const anchor = (title) => slugTitle(title).toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, "-");
    const parts = [`# 笔记合集（${matched.length} 条）`, `> 导出于 ${new Date().toISOString()}`, ""];
    for (const { note } of matched) {
      parts.push(`- [${note.title}](#${anchor(note.title)})${note.tags.length ? ` · ${note.tags.join("、")}` : ""}`);
    }
    parts.push("");
    for (const { note, body } of matched) {
      parts.push("---", "", `# ${note.title}`, "");
      if (note.tags.length) parts.push((note.tags.map((t) => `\`${t}\``).join(" ")), "");
      parts.push(String(body).trim(), "");
    }
    return { name: `notes-${new Date().toISOString().slice(0, 10)}.md`, text: parts.join("\n"), count: matched.length };
  }

  /** 导入浏览器读到的 .md/.txt 文本；同名同内容自动跳过。 */
  importMany(items = []) {
    return this.#enqueue(() => this.#importMany(items));
  }

  async #importMany(items) {
    const created = [];
    const skipped = [];
    const existing = this.#match(await this.#all(), {});
    for (const item of items.slice(0, 200)) {
      const name = String(item?.name ?? "").replace(ILLEGAL_IN_NAME, "");
      const text = String(item?.content ?? "");
      if (!/\.(md|markdown|txt)$/i.test(name)) {
        skipped.push({ name, reason: "只支持 .md / .markdown / .txt" });
        continue;
      }
      const { meta, body } = parseFrontMatter(text);
      const title = trim(meta?.title, 120) || inferTitle(body, name);
      if (!title) {
        skipped.push({ name, reason: "无法确定标题" });
        continue;
      }
      const dupe = existing.find(
        (e) => e.note.title === title && comparableBody(e.body, e.note.title) === comparableBody(body, title)
      );
      if (dupe) {
        skipped.push({ name, reason: `已存在同名同内容笔记：${dupe.note.title}` });
        continue;
      }
      const entry = await this.#create({ title, body, tags: meta?.tags ?? [], createdAt: meta?.createdAt, updatedAt: meta?.updatedAt });
      existing.push({ note: entry.note, body: entry.body });
      created.push({ id: entry.note.id, title: entry.note.title, file: entry.note.file, revision: entry.note.revision });
    }
    return { created, skipped };
  }
}
