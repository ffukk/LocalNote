import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const DAY_MS = 86_400_000;
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

function localDate(at = new Date()) {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/**
 * 每日快照：当天第一次落盘之前，把任务文件与整个笔记目录复制一份。
 * 取「写入前」的状态，所以今天误删/改坏的东西，能在昨天的快照里找回来。
 */
export class BackupManager {
  constructor({ dataFile, notesDir, backupsDir, keepDays = 7 }) {
    this.dataFile = resolve(dataFile);
    this.notesDir = resolve(notesDir);
    this.backupsDir = resolve(backupsDir);
    this.keepDays = Math.max(1, Number(keepDays) || 7);
    this.lastSnapshotDay = null;
  }

  async snapshotIfStale(now = new Date()) {
    const day = localDate(now);
    if (day === this.lastSnapshotDay) return null;
    const dest = join(this.backupsDir, day);
    if (existsSync(dest)) {
      this.lastSnapshotDay = day;
      return null;
    }
    // 还没有任何可备份的内容时不拍空快照，也不占用当天名额
    const hasData = existsSync(this.dataFile);
    const hasNotes =
      existsSync(this.notesDir) && (await readdir(this.notesDir)).some((f) => f.endsWith(".md") && !f.startsWith("_"));
    if (!hasData && !hasNotes) return null;
    await mkdir(dest, { recursive: true });
    try {
      await cp(this.dataFile, join(dest, "tasks.json"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existsSync(this.notesDir)) {
      await cp(this.notesDir, join(dest, "notes"), {
        recursive: true,
        filter: (src) => !basename(src).endsWith(".tmp"),
      });
    }
    this.lastSnapshotDay = day;
    await this.prune(now);
    return dest;
  }

  /** 只删符合日期格式的目录，绝不碰其它内容。 */
  async prune(now = new Date()) {
    if (!existsSync(this.backupsDir)) return [];
    const cutoff = localDate(new Date(now.getTime() - this.keepDays * DAY_MS));
    const removed = [];
    for (const name of await readdir(this.backupsDir)) {
      if (!DATE_DIR.test(name) || name >= cutoff) continue;
      const full = join(this.backupsDir, name);
      if (!(await stat(full)).isDirectory()) continue;
      await rm(full, { recursive: true, force: true });
      removed.push(name);
    }
    return removed;
  }

  async list() {
    if (!existsSync(this.backupsDir)) return [];
    const out = [];
    for (const name of (await readdir(this.backupsDir)).sort().reverse()) {
      if (!DATE_DIR.test(name)) continue;
      const dir = join(this.backupsDir, name);
      if (!(await stat(dir)).isDirectory()) continue;
      const files = await readdir(dir, { recursive: true });
      let bytes = 0;
      for (const file of files) {
        const full = join(dir, String(file));
        const info = await stat(full).catch(() => null);
        if (info?.isFile()) bytes += info.size;
      }
      out.push({ date: name, files: files.length, bytes });
    }
    return out;
  }
}
