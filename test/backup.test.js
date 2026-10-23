import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs, { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import { BackupManager } from "../lib/backup.js";

const roots = [];
const now = new Date(2026, 9, 20, 12);
const day = localDate(now);
const hash = (data) => createHash("sha256").update(data).digest("hex");

function localDate(at = new Date()) {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

function daysAgo(count) {
  const date = new Date(now);
  date.setDate(date.getDate() - count);
  return date;
}

async function setup(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "todo-backup-"));
  roots.push(dir);
  const dataFile = join(dir, "data", "tasks.json");
  const notesDir = join(dir, "notes");
  await mkdir(dirname(dataFile), { recursive: true });
  await mkdir(notesDir, { recursive: true });
  const backupsDir = join(dir, "data", "backups");
  const config = { dataFile, notesDir, backupsDir, ...options };
  return { dir, ...config, manager: new BackupManager(config) };
}

async function legacy(backupsDir, date = day, tasks = '{"tasks":[]}') {
  const dir = join(backupsDir, date);
  await mkdir(dir, { recursive: true });
  if (tasks !== null) await writeFile(join(dir, "tasks.json"), tasks);
  return dir;
}

async function directoryLink(target, path) {
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("快照取写入前状态，manifest 描述实际文件且同一天只拍一次", async () => {
  const { dataFile, notesDir, backupsDir, manager } = await setup();
  await writeFile(dataFile, '{"version":1,"tasks":[{"id":"t1","title":"昨天的内容"}]}');
  await writeFile(join(notesDir, "旧笔记.md"), "# 旧笔记\n\n昨天的正文");
  await writeFile(join(notesDir, "tmp.tmp"), "不该被备份");
  const dest = await manager.snapshotIfStale(now);
  assert.equal(dest, join(backupsDir, day));
  assert.match(await readFile(join(dest, "tasks.json"), "utf8"), /昨天的内容/);
  assert.equal(existsSync(join(dest, "notes", "tmp.tmp")), false);
  const manifest = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8"));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.files.length, 2);
  for (const file of manifest.files) {
    const bytes = await readFile(join(dest, file.path));
    assert.equal(file.size, bytes.length);
    assert.equal(file.sha256, hash(bytes));
  }
  await writeFile(dataFile, '{"tasks":[{"title":"今天改坏的内容"}]}');
  assert.equal(await manager.snapshotIfStale(now), null);
  assert.match(await readFile(join(dest, "tasks.json"), "utf8"), /昨天的内容/);
  assert.deepEqual(await readdir(backupsDir), [day]);
});

test("并发快照调用必须等待全部文件及清单完成，且只发布一个目录", async () => {
  const { dataFile, notesDir, backupsDir, manager } = await setup();
  await writeFile(dataFile, '{"tasks":[]}');
  for (let i = 0; i < 32; i++) await writeFile(join(notesDir, `${i}.md`), `note ${i}`);
  await Promise.all(Array.from({ length: 12 }, async () => {
    await manager.snapshotIfStale(now);
    const manifest = JSON.parse(await readFile(join(backupsDir, day, "manifest.json"), "utf8"));
    assert.equal(manifest.files.length, 33);
    assert.equal((await manager.preview(day)).verified, true);
  }));
  assert.deepEqual(await readdir(backupsDir), [day]);
});

test("复制未结束时仅有隐藏 staging，列表不可见，等待者不能提前继续", async (t) => {
  const { dataFile, notesDir, backupsDir, manager } = await setup();
  await writeFile(dataFile, '{"tasks":[]}');
  await writeFile(join(notesDir, "a.md"), "note");
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const copying = new Promise((resolve) => { entered = resolve; });
  const original = fs.cp;
  t.mock.method(fs, "cp", async (src, dest, options) => {
    if (src === notesDir) {
      entered();
      await gate;
    }
    return original(src, dest, options);
  });
  const first = manager.snapshotIfStale(now);
  await copying;
  let resumed = false;
  const second = manager.snapshotIfStale(now).then(() => { resumed = true; });
  try {
    assert.deepEqual(await manager.list(), []);
    assert.equal(existsSync(join(backupsDir, day)), false);
    assert.ok((await readdir(backupsDir)).every((name) => name.startsWith(".")));
    assert.equal(resumed, false);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  assert.deepEqual(await readdir(backupsDir), [day]);
});

test("跨日期的并发调用不会被前一天的单飞请求吞掉", async () => {
  const { dataFile, manager } = await setup();
  await writeFile(dataFile, '{"tasks":[]}');
  await Promise.all([manager.snapshotIfStale(daysAgo(1)), manager.snapshotIfStale(now)]);
  assert.deepEqual((await manager.list()).map((item) => item.date), [day, localDate(daysAgo(1))]);
});

test("复制中途失败清理本次 staging，所有等待者失败后允许重试", async (t) => {
  const { dataFile, notesDir, backupsDir, manager } = await setup();
  await writeFile(dataFile, '{"tasks":[]}');
  await writeFile(join(notesDir, "a.md"), "note");
  const original = fs.cp;
  const mocked = t.mock.method(fs, "cp", async (src, dest, options) => {
    if (src === notesDir) {
      assert.equal(existsSync(join(dirname(dest), "tasks.json")), true);
      throw Object.assign(new Error("simulated copy failure"), { code: "EIO" });
    }
    return original(src, dest, options);
  });
  const results = await Promise.allSettled([manager.snapshotIfStale(now), manager.snapshotIfStale(now)]);
  mocked.mock.restore();
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.deepEqual(await readdir(backupsDir), []);
  assert.ok(await manager.snapshotIfStale(now));
  assert.equal((await manager.preview(day)).verified, true);
});

test("未完成旧目录不视为成功、不覆盖，完成快照使用日期加 UUID 且重启可查找", async () => {
  const { dataFile, notesDir, backupsDir, manager } = await setup();
  const old = await legacy(backupsDir, day, "unfinished");
  await writeFile(dataFile, '{"tasks":[]}');
  const dest = await manager.snapshotIfStale(now);
  assert.match(basename(dest), new RegExp(`^${day}-[0-9a-f-]{36}$`));
  assert.equal(await readFile(join(old, "tasks.json"), "utf8"), "unfinished");
  const list = await manager.list();
  assert.equal(list.length, 2);
  assert.equal(list.find((item) => item.date === basename(dest)).verified, true);
  assert.equal(list.find((item) => item.date === day).verified, false);
  const restarted = new BackupManager({ dataFile, notesDir, backupsDir });
  assert.equal(await restarted.snapshotIfStale(now), null);
  assert.equal((await restarted.preview(basename(dest))).verified, true);
});

test("同一天已有损坏清单不阻止新快照，也不修改旧备份", async () => {
  const { dataFile, backupsDir, manager } = await setup();
  await writeFile(dataFile, '{"tasks":[]}');
  const first = await manager.snapshotIfStale(now);
  await writeFile(join(first, "manifest.json"), "broken");
  const next = await manager.snapshotIfStale(now);
  assert.notEqual(next, first);
  assert.equal(await readFile(join(first, "manifest.json"), "utf8"), "broken");
  assert.equal((await manager.list()).length, 2);
  assert.equal(existsSync(join(backupsDir, day)), true);
});

test("list 只数实际 payload 文件和字节；旧快照可只读预览但不声称完整", async () => {
  const { dataFile, notesDir, backupsDir, manager } = await setup();
  const raw = '{"tasks":[{"id":"a"},{"id":"b","status":"trashed"}]}';
  await writeFile(dataFile, raw);
  await mkdir(join(notesDir, "_trash"));
  await writeFile(join(notesDir, "a.md"), "中文");
  await writeFile(join(notesDir, "_trash", "b.md"), "trash");
  const dest = await manager.snapshotIfStale(now);
  const oldDate = localDate(daysAgo(2));
  const old = await legacy(backupsDir, oldDate);
  const list = await manager.list();
  assert.deepEqual(list, [
    { date: day, files: 3, bytes: Buffer.byteLength(raw + "中文trash"), verified: true },
    { date: oldDate, files: 1, bytes: 12, verified: false },
  ]);
  const preview = await manager.preview(day);
  assert.deepEqual(Object.keys(preview).sort(), ["date", "files", "bytes", "verified", "taskCount", "noteCount", "trashCount", "fingerprint"].sort());
  assert.equal(preview.taskCount, 1);
  assert.equal(preview.noteCount, 1);
  assert.equal(preview.trashCount, 2);
  assert.match(preview.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal((await manager.preview(day)).fingerprint, preview.fingerprint);
  assert.equal((await manager.preview(oldDate)).verified, false);
  assert.equal(existsSync(join(old, "manifest.json")), false);
  assert.equal(existsSync(join(dest, "manifest.json")), true);
});

test("空库不占当天名额；无 tasks 文件时只含 notes 或只含回收站均可备份", async () => {
  for (const trashOnly of [false, true]) {
    const { dataFile, notesDir, backupsDir, manager } = await setup();
    assert.equal(await manager.snapshotIfStale(now), null);
    assert.equal(existsSync(backupsDir), false);
    const noteDir = trashOnly ? join(notesDir, "_trash") : notesDir;
    await mkdir(noteDir, { recursive: true });
    await writeFile(join(noteDir, "a.md"), "only note");
    const dest = await manager.snapshotIfStale(now);
    assert.equal(existsSync(dataFile), false);
    assert.equal(existsSync(join(dest, "tasks.json")), false);
    const preview = await manager.preview(day);
    assert.equal(preview.files, 1);
    assert.equal(preview.taskCount, 0);
    assert.equal(preview.noteCount, trashOnly ? 0 : 1);
    assert.equal(preview.trashCount, trashOnly ? 1 : 0);
    assert.equal(preview.verified, true);
  }
});

test("recover 产生唯一原子副本，逐文件等价且不碰在线 tasks/notes/回收站", async () => {
  const { dataFile, notesDir, backupsDir, manager } = await setup();
  await writeFile(dataFile, '{"tasks":[{"id":"old"}]}');
  await mkdir(join(notesDir, "_trash"));
  await writeFile(join(notesDir, "a.md"), "old note");
  await writeFile(join(notesDir, "_trash", "b.md"), "deleted note");
  const dest = await manager.snapshotIfStale(now);
  const preview = await manager.preview(day);
  await writeFile(dataFile, '{"tasks":[{"id":"live"}]}');
  await writeFile(join(notesDir, "a.md"), "live note");
  await writeFile(join(notesDir, "_trash", "b.md"), "live trash");
  const first = await manager.recover(day, preview.fingerprint);
  const second = await manager.recover(day, preview.fingerprint);
  assert.deepEqual(Object.keys(first).sort(), ["bytes", "dir", "files"]);
  assert.equal(dirname(first.dir), join(dirname(backupsDir), "restore-copies"));
  assert.notEqual(first.dir, second.dir);
  assert.equal(first.files, preview.files);
  assert.equal(first.bytes, preview.bytes);
  for (const file of ["tasks.json", "notes/a.md", "notes/_trash/b.md", "manifest.json"]) {
    assert.deepEqual(await readFile(join(first.dir, file)), await readFile(join(dest, file)));
  }
  assert.match(await readFile(dataFile, "utf8"), /live/);
  assert.equal(await readFile(join(notesDir, "a.md"), "utf8"), "live note");
  assert.equal(await readFile(join(notesDir, "_trash", "b.md"), "utf8"), "live trash");
  assert.equal((await readdir(dirname(first.dir))).some((name) => name.startsWith(".")), false);
});

test("结构有效的旧备份可恢复副本，仍不为原备份生成清单", async () => {
  const { backupsDir, manager } = await setup();
  const old = await legacy(backupsDir);
  const preview = await manager.preview(day);
  const copy = await manager.recover(day, preview.fingerprint);
  assert.deepEqual(await readFile(join(copy.dir, "tasks.json")), await readFile(join(old, "tasks.json")));
  assert.equal(existsSync(join(old, "manifest.json")), false);
  assert.equal((await manager.preview(day)).verified, false);
});

test("预览后篡改文件或同步改写有效清单均拒绝旧 fingerprint", async () => {
  for (const updateManifest of [false, true]) {
    const { dataFile, manager } = await setup();
    await writeFile(dataFile, '{"tasks":[]}');
    const dest = await manager.snapshotIfStale(now);
    const preview = await manager.preview(day);
    const replacement = Buffer.from('{"tasks":[{"id":"tampered"}]}');
    await writeFile(join(dest, "tasks.json"), replacement);
    if (updateManifest) {
      await writeFile(join(dest, "manifest.json"), JSON.stringify({ version: 1, files: [
        { path: "tasks.json", size: replacement.length, sha256: hash(replacement) },
      ] }));
    }
    await assert.rejects(manager.recover(day, preview.fingerprint));
    assert.equal(existsSync(join(dirname(dest), "..", "restore-copies")), false);
  }
});

test("旧目录内容变化、清单删除和清单字节变化都使 fingerprint 失效", async () => {
  const { dataFile, backupsDir, manager } = await setup();
  const oldDate = localDate(daysAgo(1));
  const old = await legacy(backupsDir, oldDate);
  const previous = await manager.preview(oldDate);
  await writeFile(join(old, "tasks.json"), '{"tasks":[{}]}');
  await assert.rejects(manager.recover(oldDate, previous.fingerprint));
  await writeFile(dataFile, '{"tasks":[]}');
  const dest = await manager.snapshotIfStale(now);
  const preview = await manager.preview(day);
  const manifest = await readFile(join(dest, "manifest.json"));
  await writeFile(join(dest, "manifest.json"), Buffer.concat([manifest, Buffer.from("\n")]));
  await assert.rejects(manager.recover(day, preview.fingerprint));
  await rm(join(dest, "manifest.json"));
  await assert.rejects(manager.recover(day, preview.fingerprint));
});

test("恢复 staging 写入失败时清理并可重试", async (t) => {
  const { dataFile, backupsDir, manager } = await setup();
  await writeFile(dataFile, '{"tasks":[]}');
  await manager.snapshotIfStale(now);
  const preview = await manager.preview(day);
  const original = fs.writeFile;
  const mocked = t.mock.method(fs, "writeFile", async (path, ...args) => {
    if (String(path).includes("restore-copies") && basename(path) === "tasks.json") {
      throw new Error("simulated restore write failure");
    }
    return original(path, ...args);
  });
  await assert.rejects(manager.recover(day, preview.fingerprint), /simulated/);
  mocked.mock.restore();
  assert.deepEqual(await readdir(join(dirname(backupsDir), "restore-copies")), []);
  assert.ok((await manager.recover(day, preview.fingerprint)).dir);
});

test("损坏清单、非法路径、重复或缺失条目和额外文件均不能通过校验", async () => {
  const good = { path: "tasks.json", size: 12, sha256: hash('{"tasks":[]}') };
  const invalid = [
    "broken", "null", JSON.stringify({ version: 2, files: [good] }),
    JSON.stringify({ version: 1, files: [] }),
    JSON.stringify({ version: 1, files: [good, good] }),
    ...["../tasks.json", "/tasks.json", "notes/../tasks.json", "notes\\a.md", "C:/x", "notes/x:ads", "notes/CON", "notes/a.", "notes//a", "other.json"].map((path) => JSON.stringify({ version: 1, files: [{ ...good, path }] })),
    JSON.stringify({ version: 1, files: [{ ...good, size: -1 }] }),
    JSON.stringify({ version: 1, files: [{ ...good, sha256: "0".repeat(64) }] }),
  ];
  for (const raw of invalid) {
    const { backupsDir, manager } = await setup();
    const dir = await legacy(backupsDir);
    await writeFile(join(dir, "manifest.json"), raw);
    await assert.rejects(manager.preview(day), raw);
    assert.equal((await manager.list())[0].verified, false);
  }
  const { dataFile, manager } = await setup();
  await writeFile(dataFile, '{"tasks":[]}');
  const dest = await manager.snapshotIfStale(now);
  await mkdir(join(dest, "notes"), { recursive: true });
  await writeFile(join(dest, "notes", "extra.md"), "unlisted");
  await assert.rejects(manager.preview(day));
  await rm(join(dest, "notes"), { recursive: true });
  await rm(join(dest, "tasks.json"));
  await assert.rejects(manager.preview(day));
});

test("旧快照也拒绝空目录、坏 JSON、缺失 tasks 数组和未知顶层内容", async () => {
  for (const raw of [null, "{", "{}", '{"tasks":{}}']) {
    const { backupsDir, manager } = await setup();
    await legacy(backupsDir, day, raw);
    await assert.rejects(manager.preview(day));
  }
  const { backupsDir, manager } = await setup();
  const dir = await legacy(backupsDir);
  await mkdir(join(dir, "unknown"));
  await assert.rejects(manager.preview(day));
});

test("新快照 JSON 验证失败不发布，保留其它中断 staging，修复数据后可重试", async () => {
  const { dataFile, backupsDir, manager } = await setup();
  const interrupted = join(backupsDir, ".snapshot-interrupted");
  await mkdir(interrupted, { recursive: true });
  await writeFile(join(interrupted, "tasks.json"), "leave untouched");
  await writeFile(dataFile, '{"tasks":{}}');
  await assert.rejects(manager.snapshotIfStale(now));
  assert.deepEqual(await readdir(backupsDir), [".snapshot-interrupted"]);
  assert.deepEqual(await manager.list(), []);
  await writeFile(dataFile, '{"tasks":[]}');
  assert.ok(await manager.snapshotIfStale(now));
  assert.equal(await readFile(join(interrupted, "tasks.json"), "utf8"), "leave untouched");
});

test("恢复时重读 staging 验出静默写坏，或源文件在复制期间变化，均不发布副本", async (t) => {
  for (const changeSource of [false, true]) {
    const { dataFile, backupsDir, manager } = await setup();
    await writeFile(dataFile, '{"tasks":[]}');
    const dest = await manager.snapshotIfStale(now);
    const preview = await manager.preview(day);
    const original = fs.writeFile;
    const mocked = t.mock.method(fs, "writeFile", async (path, bytes, options) => {
      if (String(path).includes("restore-copies") && basename(path) === "tasks.json") {
        if (changeSource) await original(join(dest, "tasks.json"), '{"tasks":[{}]}');
        else bytes = Buffer.from('{"tasks":[{}]}');
      }
      return original(path, bytes, options);
    });
    await assert.rejects(manager.recover(day, preview.fingerprint));
    mocked.mock.restore();
    assert.deepEqual(await readdir(join(dirname(backupsDir), "restore-copies")), []);
  }
});

test("文件符号链接不可冒充 tasks.json、manifest 或普通笔记", async (t) => {
  const { dir, backupsDir, manager } = await setup();
  const outside = join(dir, "outside.json");
  await writeFile(outside, '{"tasks":[]}');
  const old = await legacy(backupsDir, day, null);
  for (const name of ["tasks.json", "manifest.json", "notes/a.md"]) {
    const path = join(old, name);
    await mkdir(dirname(path), { recursive: true });
    try {
      await symlink(outside, path, "file");
    } catch (error) {
      if (error.code === "EPERM" && process.platform === "win32") {
        t.skip("Windows 当前用户没有文件符号链接权限；目录 junction 保护另有覆盖");
        return;
      }
      throw error;
    }
    await assert.rejects(manager.preview(day));
    assert.equal((await manager.list())[0].verified, false);
    await rm(path);
  }
  assert.equal(await readFile(outside, "utf8"), '{"tasks":[]}');
});

test("date 必须是单一合法日期或日期加 UUID，preview/recover 不接受路径穿越", async () => {
  const { backupsDir, manager } = await setup();
  await legacy(backupsDir);
  for (const date of ["../notes", `../${day}`, `${day}/notes`, `${day}\\notes`, `/tmp/${day}`, `C:\\${day}`, `${day}-manual`, "2026-02-30", "", null]) {
    await assert.rejects(manager.preview(date));
    await assert.rejects(manager.recover(date, "0".repeat(64)));
  }
  for (const fingerprint of [null, "", "not-a-hash", "0".repeat(64)]) {
    await assert.rejects(manager.recover(day, fingerprint));
  }
});

test("拒绝备份根、快照根及 notes 子目录符号链接，不读取链接目标", async () => {
  const { dir, backupsDir, manager } = await setup();
  const outside = join(dir, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "tasks.json"), '{"tasks":[]}');
  await mkdir(backupsDir);
  await directoryLink(outside, join(backupsDir, day));
  await assert.rejects(manager.preview(day));
  assert.deepEqual(await manager.list(), []);
  await rm(join(backupsDir, day), { recursive: true });
  const old = await legacy(backupsDir);
  await directoryLink(outside, join(old, "notes"));
  await assert.rejects(manager.preview(day));
  await rm(backupsDir, { recursive: true });
  await directoryLink(outside, backupsDir);
  await assert.rejects(manager.list());
  assert.equal(await readFile(join(outside, "tasks.json"), "utf8"), '{"tasks":[]}');
});

test("危险嵌套配置和 live notes 内目录链接被拒绝，绝不递归复制", async () => {
  const config = await setup();
  assert.throws(() => new BackupManager({ ...config, backupsDir: join(config.notesDir, "backups") }));
  assert.throws(() => new BackupManager({ ...config, backupsDir: config.notesDir }));
  const restoreRoot = join(dirname(config.backupsDir), "restore-copies");
  assert.throws(() => new BackupManager({ ...config, notesDir: join(restoreRoot, "notes") }));
  await writeFile(config.dataFile, '{"tasks":[]}');
  await directoryLink(config.dir, join(config.notesDir, "loop"));
  await assert.rejects(config.manager.snapshotIfStale(now));
  if (existsSync(config.backupsDir)) assert.deepEqual(await readdir(config.backupsDir), []);
});

test("restore-copies 符号链接不可用于向外部写入", async () => {
  const { dir, dataFile, backupsDir, manager } = await setup();
  await writeFile(dataFile, '{"tasks":[]}');
  await manager.snapshotIfStale(now);
  const outside = join(dir, "outside");
  await mkdir(outside);
  await directoryLink(outside, join(dirname(backupsDir), "restore-copies"));
  const preview = await manager.preview(day);
  await assert.rejects(manager.recover(day, preview.fingerprint));
  assert.deepEqual(await readdir(outside), []);
});

test("保留期含今天共七天：只删除过期且清单有效的受管理快照", async () => {
  const { dataFile, backupsDir, manager } = await setup();
  await writeFile(dataFile, '{"tasks":[]}');
  const expiredDate = localDate(daysAgo(7));
  await legacy(backupsDir, expiredDate); // 未验证的同日目录必须保留。
  const expired = await manager.snapshotIfStale(daysAgo(7));
  assert.notEqual(basename(expired), expiredDate);
  const boundary = await manager.snapshotIfStale(daysAgo(6));
  const older = localDate(daysAgo(20));
  const corrupt = await legacy(backupsDir, `${older}-${randomUUID()}`);
  await writeFile(join(corrupt, "manifest.json"), "broken");
  const manual = await legacy(backupsDir, "manual-copy");
  const nonManaged = await legacy(backupsDir, `${older}-manual`);
  const raw = '{"tasks":[]}';
  const validManifest = JSON.stringify({ version: 1, files: [{ path: "tasks.json", size: raw.length, sha256: hash(raw) }] });
  await writeFile(join(manual, "manifest.json"), validManifest);
  await writeFile(join(nonManaged, "manifest.json"), validManifest);
  const removed = await manager.prune(now);
  assert.deepEqual(removed, [basename(expired)]);
  for (const path of [join(backupsDir, expiredDate), boundary, corrupt, manual, nonManaged]) assert.equal(existsSync(path), true);
  assert.equal(existsSync(expired), false);
  assert.deepEqual(await manager.prune(now), []);
});

test("keepDays=1 只保留今天；使用日历日期跨月计算边界", async () => {
  const { dataFile, manager } = await setup({ keepDays: 1 });
  await writeFile(dataFile, '{"tasks":[]}');
  const yesterday = await manager.snapshotIfStale(new Date(2026, 9, 31, 12));
  const today = await manager.snapshotIfStale(new Date(2026, 10, 1, 12));
  assert.equal(existsSync(yesterday), false);
  assert.equal(existsSync(today), true);
});
