import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";

import { newId } from "./tasks.js";

export class NotesError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
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

/** 笔记库：notes/ 下一个 .md 文件即一条笔记，外部编辑器改完刷新即可见。 */
export class NotesLibrary {
  constructor(dir) {
    this.dir = resolve(dir);
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
    const [raw, info] = await Promise.all([readFile(full, "utf8"), stat(full)]);
    const { meta, body } = parseFrontMatter(raw);
    const fileStem = basename(file, ".md");
    const note = {
      id: trim(meta?.id, 160) || fileStem,
      file: fileStem,
      title: trim(meta?.title, 120) || inferTitle(body, file),
      tags: meta?.tags ?? [],
      pinned: Boolean(meta?.pinned),
      createdAt: meta?.createdAt ?? info.birthtime.toISOString(),
      updatedAt: meta?.updatedAt ?? info.mtime.toISOString(),
      words: countWords(body),
    };
    return { note, body, path: full, raw };
  }

  async #all() {
    const files = await this.#files();
    const entries = await Promise.all(
      files.map((file) =>
        this.#readEntry(file).catch((error) => {
          console.error(`[notes] 跳过无法读取的文件 ${file}: ${error.message}`);
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
        note.hit = entry.body.replace(/\s+/g, " ").slice(Math.max(0, at - 40), at + 140);
      }
      matched.push({ note, body: entry.body });
    }
    matched.sort((a, b) => Number(b.note.pinned) - Number(a.note.pinned) || String(b.note.updatedAt).localeCompare(String(a.note.updatedAt)));
    return matched;
  }

  async list(filter = {}) {
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

  async get(id) {
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

  async #write(path, text) {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(tmp, text, "utf8");
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tmp, path);
        return;
      } catch (error) {
        if (error.code !== "EPERM" || attempt >= 4) {
          await unlink(tmp).catch(() => {});
          if (error.code === "EPERM") throw new NotesError("笔记文件被其它程序占用，请关闭编辑器后重试", 409);
          throw error;
        }
        await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
      }
    }
  }

  async create(input = {}) {
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

  async update(id, patch = {}) {
    const entry = await this.#require(id);
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
    const wanted = slugTitle(title, meta.id);
    const name = wanted === entry.note.file ? entry.note.file : await this.#uniqueName(wanted, meta.id);
    const path = this.#safePath(name);
    await this.#write(path, serializeNote(meta, body));
    if (path !== entry.path) {
      try {
        await unlink(entry.path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return this.#readEntry(basename(path));
  }

  async remove(id) {
    const entry = await this.#require(id);
    await unlink(entry.path);
    return { removed: entry.note.id, file: entry.note.file, title: entry.note.title };
  }

  /** 浏览器剪藏：追加到指定标题的笔记，笔记不存在时创建。 */
  async appendClip(input = {}, at = new Date()) {
    const wanted = trim(input.noteTitle, 80) || "网页剪藏";
    const block = clipBlock(input, at);
    const existing = (await this.#all()).find((e) => e.note.title === wanted);
    if (!existing) {
      const header = `# ${wanted}\n\n由浏览器扩展剪藏，最新内容追加在最后。\n\n---`;
      const entry = await this.create({
        title: wanted,
        body: `${header}\n\n${block}\n`,
        tags: ["剪藏"],
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
      });
      return { note: entry.note, created: true };
    }
    const body = `${existing.body.replace(/\s+$/, "")}\n\n${block}\n`;
    const entry = await this.update(existing.note.id, { body });
    return { note: entry.note, created: false };
  }

  async exportOne(id) {
    const entry = await this.#require(id);
    return { name: `${entry.note.file}.md`, text: entry.raw };
  }

  /** 合并导出为单份 Markdown（带目录），避免引入压缩依赖。 */
  async exportAll(filter = {}) {
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
  async importMany(items = []) {
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
      const entry = await this.create({ title, body, tags: meta?.tags ?? [], createdAt: meta?.createdAt, updatedAt: meta?.updatedAt });
      created.push({ id: entry.note.id, title: entry.note.title, file: entry.note.file });
    }
    return { created, skipped };
  }
}
