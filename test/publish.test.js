import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "tools", "publish.mjs");

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: ROOT });
}

async function tempDest() {
  return join(await mkdtemp(join(tmpdir(), "todo-publish-")), "out");
}

async function listAll(dir) {
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { recursive: true })).map((p) => String(p).replace(/\\/g, "/"));
}

test("发布脚本的黑名单包含用户数据目录", async () => {
  const src = await readFileText(join(ROOT, "tools", "publish.mjs"));
  assert.match(src, /const NEVER = \[[^\]]*"data"[^\]]*"notes"/s, "NEVER 必须同时列出 data 与 notes");
  assert.match(src, /const INCLUDE =/, "采用白名单而不是全量复制");
});

async function readFileText(path) {
  return (await import("node:fs/promises")).readFile(path, "utf8");
}

test("--dry 不写入任何文件", async () => {
  const dest = await tempDest();
  const res = run(["--dest", dest, "--dry"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /将复制 \d+ 个文件/);
  assert.equal(existsSync(dest), false, "试运行不应创建目标目录内容");
});

test("复制结果是纯代码，且不含任何用户数据", async () => {
  const dest = await tempDest();
  const res = run(["--dest", dest]);
  assert.equal(res.status, 0, res.stderr);

  const entries = await readdir(dest);
  assert.deepEqual(
    entries.sort(),
    [".gitattributes", ".github", ".gitignore", "README.md", "docs", "extension", "lib", "package.json", "public", "server.js", "test", "tools"].sort()
  );
  assert.equal(entries.includes("LICENSE"), false, "LICENSE 由发布仓库自己维护，同步脚本不得覆盖");

  const files = await listAll(dest);
  assert.ok(files.includes("server.js"));
  assert.ok(files.includes("extension/manifest.json"));
  assert.ok(files.includes("public/manifest.webmanifest"));
  assert.ok(files.includes(".github/workflows/ci.yml"));
  assert.equal(files.filter((f) => f.startsWith("lib/")).length, 7);
  assert.equal(files.filter((f) => f.startsWith("test/")).length, 6);

  for (const forbidden of ["data", "notes", "node_modules", "Python"]) {
    assert.equal(
      files.some((f) => f.split("/").includes(forbidden)),
      false,
      `发布副本里不该出现 ${forbidden}/（源目录若存在则说明白名单失守）`
    );
  }
  assert.equal(files.some((f) => f.endsWith(".tmp")), false, "临时文件不该被复制");

  const pkg = JSON.parse(await readFileText(join(dest, "package.json")));
  assert.equal(pkg.private, undefined, "开源包不应保留 private:true");
  assert.equal(pkg.license, "MIT");
});

test("重复执行是幂等的，且不会删除目标里的既有数据", async () => {
  const dest = await tempDest();
  assert.equal(run(["--dest", dest]).status, 0);
  const first = await listAll(dest);

  await mkdir(join(dest, "data"), { recursive: true });
  await writeFile(join(dest, "data", "tasks.json"), '{"keep":true}', "utf8");

  const again = run(["--dest", dest, "--force"]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /目标目录已存在 data/, "应明确报警");
  assert.equal(JSON.parse(await readFileText(join(dest, "data", "tasks.json"))).keep, true, "脚本不得删除目标数据");

  const second = await listAll(dest);
  assert.deepEqual(second.filter((f) => !f.startsWith("data")).sort(), first.sort());
});

test("目标目录有无关文件时默认拒绝，但容忍 .git 与 .idea", async () => {
  const dest = await tempDest();
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, "别的东西.txt"), "x", "utf8");
  const refused = run(["--dest", dest]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /已有其它文件/);

  await mkdir(join(dest, ".idea"), { recursive: true });
  await writeFile(join(dest, ".idea", "misc.xml"), "<x/>", "utf8");
  await rm(join(dest, "别的东西.txt"));
  const withIde = run(["--dest", dest]);
  assert.equal(withIde.status, 0, withIde.stderr);
  assert.ok((await listAll(dest)).some((f) => f === "server.js"), "IDE 目录不该阻塞同步");

  const noDest = run([]);
  assert.equal(noDest.status, 2);
  assert.match(noDest.stderr, /缺少 --dest/);

  const selfDest = run(["--dest", ROOT]);
  assert.equal(selfDest.status, 2);
  assert.match(selfDest.stderr, /不能是源仓库自身/);
});
