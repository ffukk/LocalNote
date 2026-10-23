import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_SETTINGS = {
  weekStart: 1,
  dueEodTime: "23:59",
  defaultRemindMinutes: 0,
  reminderPollSeconds: 60,
};

export const DEFAULT_DATA = {
  version: 1,
  seeded: false,
  projects: [],
  tasks: [],
  settings: { ...DEFAULT_SETTINGS },
};

function isDateISO(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function normalize(raw) {
  const data = { ...structuredClone(DEFAULT_DATA), ...raw };
  data.version = 1;
  data.seeded = Boolean(data.seeded);
  data.projects = Array.isArray(data.projects) ? data.projects : [];
  data.tasks = Array.isArray(data.tasks) ? data.tasks : [];
  data.settings = { ...DEFAULT_SETTINGS, ...(raw?.settings ?? {}) };
  if (!Number.isFinite(data.settings.weekStart)) data.settings.weekStart = 1;
  if (!isDateISO(data.settings.startDate)) delete data.settings.startDate;
  return data;
}

/** 单文件 JSON 存储：串行写入 + 临时文件改名，避免并发写坏文件。 */
export class JsonStore {
  #loading = null;

  constructor(filePath) {
    this.filePath = filePath;
    this.data = structuredClone(DEFAULT_DATA);
    this.loaded = false;
    this.writing = Promise.resolve();
    /** 落盘前的钩子（自动备份用），由 server 注入 */
    this.onWrite = null;
  }

  async read() {
    if (!this.loaded) await this.load();
    return this.data;
  }

  load() {
    if (this.loaded) return Promise.resolve(this.data);
    if (!this.#loading) {
      this.#loading = this.#load().finally(() => { this.#loading = null; });
    }
    return this.#loading;
  }

  async #load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.data = normalize(JSON.parse(raw));
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`数据文件解析失败 (${this.filePath}): ${error.message}`);
      this.data = structuredClone(DEFAULT_DATA);
    }
    this.loaded = true;
    return this.data;
  }

  async #flush(draft) {
    // 先让备份拿到「写入前」的磁盘状态，再落新内容
    if (this.onWrite) await this.onWrite();
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
      // Windows 上目标文件可能刚被读取而短暂锁定，重试代替直接失败
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rename(tmp, this.filePath);
          return;
        } catch (error) {
          if (error.code !== "EPERM" || attempt >= 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        }
      }
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }

  /** mutator 修改隔离草稿并返回结果；仅落盘成功后发布，read 不暴露未提交内容。 */
  async update(mutator) {
    const run = async () => {
      await this.read();
      const draft = structuredClone(this.data);
      const result = await mutator(draft);
      await this.#flush(draft);
      this.data = draft;
      return result;
    };
    const chained = this.writing.then(run, run);
    this.writing = chained.then(
      () => undefined,
      () => undefined
    );
    return chained;
  }

  async save() {
    return this.update(() => undefined);
  }
}
