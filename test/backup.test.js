import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BackupManager } from "../lib/backup.js";

const DAY_MS = 86_400_000;

function localDate(at = new Date()) {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "todo-backup-"));
  const dataFile = join(dir, "data", "tasks.json");
  const notesDir = join(dir, "notes");
  await mkdir(join(dir, "data"), { recursive: true });
  await mkdir(notesDir, { recursive: true });
  const backupsDir = join(dir, "data", "backups");
  return { dir, dataFile, notesDir, backupsDir, manager: new BackupManager({ dataFile, notesDir, backupsDir }) };
}

test("快照取的是写入前的状态，同一天只拍一次", async () => {
  const { dataFile, notesDir, backupsDir, manager } = await setup();
  await writeFile(dataFile, '{"version":1,"tasks":[{"id":"t1","title":"昨天的内容"}]}');
  await writeFile(join(notesDir, "旧笔记.md"), "# 旧笔记\n\n昨天的正文");
  await writeFile(join(notesDir, "tmp.tmp"), "不该被备份");

  const dest = await manager.snapshotIfStale();
  assert.ok(dest, "第一次应生成快照");
  const snapTasks = await readFile(join(dest, "tasks.json"), "utf8");
  assert.match(snapTasks, /昨天的内容/);
  assert.match(await readFile(join(dest, "notes", "旧笔记.md"), "utf8"), /昨天的正文/);
  assert.equal(existsSync(join(dest, "notes", "tmp.tmp")), false, "临时文件不进备份");

  await writeFile(dataFile, '{"version":1,"tasks":[{"id":"t1","title":"今天改坏的内容"}]}');
  assert.equal(await manager.snapshotIfStale(), null, "同一天不再重复快照");
  assert.match(await readFile(join(dest, "tasks.json"), "utf8"), /昨天的内容/, "快照保持写入前的状态");

  const listing = await readdir(backupsDir);
  assert.deepEqual(listing, [localDate()]);
});

test("保留期：只删超过 keepDays 的日期目录，其它一律不碰", async () => {
  const { backupsDir, manager } = await setup();
  const old = localDate(new Date(Date.now() - 8 * DAY_MS));
  const keep = localDate(new Date(Date.now() - 3 * DAY_MS));
  for (const name of [old, keep, "manual-copy"]) {
    await mkdir(join(backupsDir, name), { recursive: true });
    await writeFile(join(backupsDir, name, "tasks.json"), "{}");
  }
  const removed = await manager.prune();
  assert.deepEqual(removed, [old]);
  const left = await readdir(backupsDir);
  assert.ok(left.includes(keep) && left.includes("manual-copy"), `非日期目录不受影响：${left.join(",")}`);
  assert.equal(left.includes(old), false);
});

test("list 返回日期倒序与体积统计", async () => {
  const { dataFile, notesDir, backupsDir, manager } = await setup();
  await writeFile(dataFile, '{"tasks":[]}');
  await writeFile(join(notesDir, "a.md"), "内容内容内容");
  await manager.snapshotIfStale();
  const old = localDate(new Date(Date.now() - 2 * DAY_MS));
  await mkdir(join(backupsDir, old), { recursive: true });
  await writeFile(join(backupsDir, old, "tasks.json"), '{"tasks":[]}');

  const list = await manager.list();
  assert.deepEqual(list.map((b) => b.date), [localDate(), old], "新日期在前");
  assert.ok(list[0].bytes > 0 && list[0].files >= 2, JSON.stringify(list[0]));
});

test("数据文件还不存在时也能快照（只备笔记）；空库不拍空快照", async () => {
  const { dataFile, notesDir, backupsDir } = await setup();
  assert.equal(existsSync(dataFile), false, "setup 不创建数据文件");
  const manager = new BackupManager({ dataFile, notesDir, backupsDir });
  assert.equal(await manager.snapshotIfStale(), null, "什么都没有时不该建空目录");
  assert.equal(existsSync(backupsDir), false);

  await writeFile(join(notesDir, "只有笔记.md"), "# 只有笔记");
  const dest = await manager.snapshotIfStale();
  assert.ok(dest);
  assert.equal(existsSync(join(dest, "tasks.json")), false);
  assert.match(await readFile(join(dest, "notes", "只有笔记.md"), "utf8"), /只有笔记/);
});
