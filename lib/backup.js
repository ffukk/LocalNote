import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const DATE_DIR = /^\d{4}-\d{2}-\d{2}(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export class BackupError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

function localDate(at = new Date()) {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

function validDate(name) {
  if (typeof name !== "string" || !DATE_DIR.test(name)) return false;
  const day = name.slice(0, 10);
  const parsed = new Date(`${day}T12:00:00`);
  return Number.isFinite(parsed.getTime()) && localDate(parsed) === day;
}

function requireDate(date) {
  if (!validDate(date)) throw new BackupError("非法备份日期或目录名", 400);
}

function within(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function maybeStat(path) {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// 检查路径及祖先，不能通过目录链接绕过隔离；不遍历在线数据内容。
async function noLinks(path) {
  const parents = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    parents.push(current);
    if (dirname(current) === current) break;
  }
  for (const current of parents.reverse()) {
    const info = await maybeStat(current);
    if (info?.isSymbolicLink()) throw new Error(`备份不允许符号链接: ${current}`);
  }
}

function safeComponent(name) {
  return name !== "" && name !== "." && name !== ".." &&
    !/[\\/:*?"<>|\x00-\x1f]/.test(name) && !/[. ]$/.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

function payloadPath(path) {
  return typeof path === "string" && path.split("/").every(safeComponent) &&
    (path === "tasks.json" || path.startsWith("notes/"));
}

async function readRegular(path) {
  await noLinks(path);
  const before = await fs.lstat(path);
  if (!before.isFile()) throw new Error(`备份仅允许普通文件: ${path}`);
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`读取期间文件已替换: ${path}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await fs.lstat(path);
    if (current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs ||
        bytes.length !== after.size) {
      throw new Error(`读取期间文件已修改: ${path}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

// 仅扫描备份/恢复 staging，不拿在线数据与历史快照比较。
async function inventory(dir) {
  const files = [];
  const directories = [];
  let manifest = null;
  let tasks = null;
  async function walk(path, prefix = "") {
    await noLinks(path);
    if (!(await fs.lstat(path)).isDirectory()) throw new Error("备份目录结构无效");
    for (const name of (await fs.readdir(path)).sort()) {
      if (!safeComponent(name)) throw new Error(`非法备份文件名: ${name}`);
      const rel = prefix ? `${prefix}/${name}` : name;
      const full = join(path, name);
      const info = await fs.lstat(full);
      if (info.isSymbolicLink()) throw new Error(`备份不允许符号链接: ${rel}`);
      if (info.isDirectory()) {
        if (rel !== "notes" && !rel.startsWith("notes/")) throw new Error(`未知备份目录: ${rel}`);
        directories.push(rel);
        await walk(full, rel);
      } else {
        if (rel !== "manifest.json" && !payloadPath(rel)) throw new Error(`未知备份文件: ${rel}`);
        const bytes = await readRegular(full);
        if (rel === "manifest.json") manifest = bytes;
        else {
          files.push({ path: rel, size: bytes.length, sha256: digest(bytes) });
          if (rel === "tasks.json") tasks = bytes;
        }
      }
    }
  }
  await walk(dir);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, directories: directories.sort(), manifest, tasks };
}

function parseJSON(bytes) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function validate(contents, date) {
  if (!contents.files.length) throw new Error("备份没有可恢复的文件");
  let tasks = [];
  if (contents.tasks !== null) {
    const data = parseJSON(contents.tasks);
    if (!data || !Array.isArray(data.tasks)) throw new Error("tasks.json 必须包含 tasks 数组");
    tasks = data.tasks;
  }
  const verified = contents.manifest !== null;
  if (verified) {
    const manifest = parseJSON(contents.manifest);
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files) ||
        manifest.files.length !== contents.files.length) throw new Error("备份清单格式或文件数量无效");
    const expected = new Map(contents.files.map((file) => [file.path, file]));
    for (const entry of manifest.files) {
      if (!entry || !payloadPath(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
          typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) throw new Error("备份清单包含非法条目");
      const actual = expected.get(entry.path);
      if (!actual || actual.size !== entry.size || actual.sha256 !== entry.sha256) {
        throw new Error(`备份清单与文件不匹配: ${entry.path}`);
      }
      expected.delete(entry.path); // 重复条目也不能冒充完整清单。
    }
    if (expected.size) throw new Error("备份清单缺少文件");
  }
  const trashTasks = tasks.filter((task) => task?.status === "trashed").length;
  const markdown = contents.files.filter((file) => file.path.startsWith("notes/") && /\.md$/i.test(file.path));
  // 活跃任务/笔记不含回收站；trashCount 合计回收任务与回收 Markdown 笔记。
  const noteCount = markdown.filter((file) => file.path.split("/").slice(1).every((part) => !/^[_.]/.test(part))).length;
  return {
    date,
    files: contents.files.length,
    bytes: contents.files.reduce((sum, file) => sum + file.size, 0),
    verified,
    taskCount: tasks.length - trashTasks,
    noteCount,
    trashCount: trashTasks + markdown.filter((file) => file.path.startsWith("notes/_trash/")).length,
    // 包括清单原始字节与空目录，旧快照也能检测 preview 后的变化。
    fingerprint: digest(JSON.stringify({
      date, files: contents.files, directories: contents.directories,
      manifest: contents.manifest === null ? null : digest(contents.manifest),
    })),
  };
}

async function inspect(dir, date) {
  const contents = await inventory(dir);
  return { contents, summary: validate(contents, date) };
}

/** 每日写入前快照。清单只证明备份内部完整，不保证旧目录或在线数据的完整性。 */
export class BackupManager {
  constructor({ dataFile, notesDir, backupsDir, keepDays = 7 }) {
    this.dataFile = resolve(dataFile);
    this.notesDir = resolve(notesDir);
    this.backupsDir = resolve(backupsDir);
    this.restoreDir = join(dirname(this.backupsDir), "restore-copies");
    for (const root of [this.backupsDir, this.restoreDir]) {
      if (within(this.notesDir, root) || within(root, this.notesDir) || within(root, this.dataFile)) {
        throw new Error("备份/恢复目录不能与在线数据目录重叠");
      }
    }
    if (within(this.backupsDir, this.restoreDir) || within(this.restoreDir, this.backupsDir)) {
      throw new Error("备份目录不能与 restore-copies 重叠");
    }
    const days = Number(keepDays);
    this.keepDays = Number.isFinite(days) ? Math.max(1, Math.floor(days || 7)) : 7;
    this.lastSnapshotDay = null;
    this.snapshotPromise = null;
  }

  async snapshotIfStale(now = new Date()) {
    // 等待发布与清理结束；跨日期调用等待后重新判断，失败传播给所有等待者。
    while (this.snapshotPromise) await this.snapshotPromise;
    const pending = this.#snapshot(now);
    this.snapshotPromise = pending;
    try {
      return await pending;
    } finally {
      this.snapshotPromise = null;
    }
  }

  async #names() {
    await noLinks(this.backupsDir);
    const info = await maybeStat(this.backupsDir);
    if (!info) return [];
    if (!info.isDirectory()) throw new Error("备份根路径不是目录");
    return (await fs.readdir(this.backupsDir, { withFileTypes: true }))
      .filter((entry) => validDate(entry.name) && entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name).sort().reverse();
  }

  async #snapshot(now) {
    const day = localDate(now);
    requireDate(day);
    for (const date of await this.#names()) {
      if (date.slice(0, 10) !== day) continue;
      const existing = await inspect(join(this.backupsDir, date), date).catch(() => null);
      if (existing?.summary.verified) {
        this.lastSnapshotDay = day;
        return null;
      }
    }
    await noLinks(this.dataFile);
    await noLinks(this.notesDir);
    const data = await maybeStat(this.dataFile);
    const notes = await maybeStat(this.notesDir);
    if (data && !data.isFile()) throw new Error("在线 tasks 路径不是普通文件");
    if (notes && !notes.isDirectory()) throw new Error("在线 notes 路径不是目录");
    const hasNotes = notes && (await fs.readdir(this.notesDir)).some((name) => !name.endsWith(".tmp"));
    if (!data && !hasNotes) return null;

    await fs.mkdir(this.backupsDir, { recursive: true });
    await noLinks(this.backupsDir);
    let staging = await fs.mkdtemp(join(this.backupsDir, ".snapshot-"));
    try {
      if (data) await fs.cp(this.dataFile, join(staging, "tasks.json"), { force: false, errorOnExist: true });
      if (notes) {
        await fs.cp(this.notesDir, join(staging, "notes"), {
          recursive: true, force: false, errorOnExist: true,
          filter: async (src) => {
            if (src !== this.notesDir && basename(src).endsWith(".tmp")) return false;
            const info = await fs.lstat(src);
            if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
              throw new Error(`在线笔记包含链接或非普通文件: ${src}`);
            }
            return true;
          },
        });
      }
      const contents = await inventory(staging);
      if (!contents.files.length) return null;
      validate(contents, day);
      await fs.writeFile(join(staging, "manifest.json"), JSON.stringify({ version: 1, files: contents.files }), { flag: "wx" });
      await inspect(staging, day);
      await noLinks(this.backupsDir);
      // 旧目录即使为空也保留，只有新 staging 可被本次调用删除。
      let dest = join(this.backupsDir, day);
      if (await maybeStat(dest)) dest = join(this.backupsDir, `${day}-${randomUUID()}`);
      await fs.rename(staging, dest);
      staging = null;
      this.lastSnapshotDay = day;
      await this.prune(now);
      return dest;
    } finally {
      if (staging) await fs.rm(staging, { recursive: true, force: true });
    }
  }

  /** 含今天的 keepDays 个本地日历日；旧目录、损坏快照、手工命名目录不删。 */
  async prune(now = new Date()) {
    requireDate(localDate(now));
    const boundary = new Date(now);
    boundary.setDate(boundary.getDate() - (this.keepDays - 1));
    const cutoff = localDate(boundary);
    const removed = [];
    for (const date of await this.#names()) {
      if (date.slice(0, 10) >= cutoff) continue;
      const dir = join(this.backupsDir, date);
      const snapshot = await inspect(dir, date).catch(() => null);
      if (!snapshot?.summary.verified) continue;
      await noLinks(dir);
      await fs.rm(dir, { recursive: true, force: true });
      removed.push(date);
    }
    return removed;
  }

  /** files/bytes 仅统计 payload，不包含目录和 manifest；无效目录仍显示未验证。 */
  async list() {
    const out = [];
    for (const date of await this.#names()) {
      let contents;
      let verified = false;
      try {
        contents = await inventory(join(this.backupsDir, date));
        verified = validate(contents, date).verified;
      } catch {
        // 结构本身非法时不遍历链接或未知路径，安全返回零统计。
      }
      out.push({
        date, files: contents?.files.length ?? 0,
        bytes: contents?.files.reduce((sum, file) => sum + file.size, 0) ?? 0,
        verified,
      });
    }
    return out;
  }

  async preview(date) {
    requireDate(date);
    const source = join(this.backupsDir, date);
    if (!(await maybeStat(source))) throw new BackupError("备份不存在", 404);
    return (await inspect(source, date)).summary;
  }

  /** 只创建独立恢复副本，绝不覆盖 dataFile/notesDir，也不修改原备份。 */
  async recover(date, fingerprint) {
    requireDate(date);
    if (typeof fingerprint !== "string" || !SHA256.test(fingerprint)) throw new BackupError("缺少有效的预览 fingerprint", 400);
    const source = join(this.backupsDir, date);
    if (!(await maybeStat(source))) throw new BackupError("备份不存在", 404);
    const { contents, summary } = await inspect(source, date);
    if (summary.fingerprint !== fingerprint) throw new BackupError("备份已变化，请重新预览");
    await noLinks(this.restoreDir);
    await fs.mkdir(this.restoreDir, { recursive: true });
    await noLinks(this.restoreDir);
    let staging = await fs.mkdtemp(join(this.restoreDir, ".restore-"));
    try {
      for (const dir of contents.directories) await fs.mkdir(join(staging, dir), { recursive: true });
      // 对旧快照，contents.files 是本次只读校验生成的临时清单，不回写旧目录。
      for (const entry of contents.files) {
        const bytes = await readRegular(join(source, entry.path));
        if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) throw new Error("恢复期间备份已变化");
        await fs.writeFile(join(staging, entry.path), bytes, { flag: "wx" });
      }
      if (contents.manifest !== null) await fs.writeFile(join(staging, "manifest.json"), contents.manifest, { flag: "wx" });
      const copy = await inspect(staging, date);
      const latest = await inspect(source, date);
      if (copy.summary.fingerprint !== fingerprint || latest.summary.fingerprint !== fingerprint) {
        throw new Error("备份或恢复副本校验失败，请重新预览");
      }
      await noLinks(this.restoreDir);
      const dir = join(this.restoreDir, `${date}-${randomUUID()}`);
      await fs.rename(staging, dir);
      staging = null;
      return { dir, files: summary.files, bytes: summary.bytes };
    } finally {
      if (staging) await fs.rm(staging, { recursive: true, force: true });
    }
  }
}
