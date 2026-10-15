/**
 * 产出对外发布副本：只复制代码与文档，绝不复制用户数据。
 * 用法：node tools/publish.mjs --dest D:/LocalNote [--dry] [--force]
 *   --dry  只打印将要复制的内容，不落盘
 *   --force 允许目标目录已存在文件（默认只允许空目录或已存在的 git 仓库）
 */
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** 对外发布的白名单：新增顶层文件要显式加进来，避免误把杂物发布出去。 */
const INCLUDE = [
  "server.js",
  "package.json",
  "README.md",
  // LICENSE 由发布仓库自己维护（远端已提交的署名版本），同步不覆盖它
  ".gitignore",
  ".gitattributes",
  "docs",
  ".github",
  "lib",
  "public",
  "extension",
  "tools",
  "test",
];

/** 无论如何都不复制的目录/文件（用户数据、依赖、本地环境）。 */
const NEVER = ["data", "notes", "node_modules", ".git", "Python", "tmp", ".env"];

const args = process.argv.slice(2);
const inline = args.find((a) => a.startsWith("--dest="));
const next = args.indexOf("--dest");
const destArg = inline ? inline.slice("--dest=".length) : next >= 0 ? args[next + 1] : undefined;
if (!destArg || destArg.startsWith("--")) {
  console.error("缺少 --dest，例如：node tools/publish.mjs --dest D:/LocalNote");
  process.exit(2);
}
const dryRun = args.includes("--dry");
const force = args.includes("--force");
const dest = resolve(destArg);

if (dest === ROOT) {
  console.error("目标目录不能是源仓库自身");
  process.exit(2);
}

const skipped = [];
const copied = [];
const missing = [];

// 白名单里若混进数据目录，直接拒绝执行（NEVER 永远优先）
const conflict = INCLUDE.filter((item) => NEVER.includes(item));
if (conflict.length) {
  console.error(`INCLUDE 里出现了不该发布的条目：${conflict.join(", ")}`);
  process.exit(2);
}

function isForbidden(path) {
  const parts = path.split(/[\\/]/);
  return parts.some((part) => NEVER.includes(part));
}

async function copyTree(srcRel) {
  if (isForbidden(srcRel)) {
    skipped.push(srcRel);
    return;
  }
  const src = join(ROOT, srcRel);
  if (!existsSync(src)) {
    missing.push(srcRel);
    return;
  }
  const info = await stat(src);
  if (info.isFile()) {
    copied.push(srcRel);
    if (!dryRun) await cp(src, join(dest, srcRel), { force: true });
    return;
  }
  for (const entry of await readdir(src, { recursive: true })) {
    const rel = String(entry);
    const full = rel.replace(/\\/g, "/");
    if (isForbidden(full)) {
      skipped.push(full);
      continue;
    }
    const entryInfo = await stat(join(src, rel));
    if (!entryInfo.isFile()) continue;
    if (full.endsWith(".tmp")) {
      skipped.push(full);
      continue;
    }
    copied.push(full);
    if (!dryRun) await cp(join(src, rel), join(dest, srcRel, rel), { force: true });
  }
}

// 目标里可能已有仓库自身、IDE 或许可证文件，它们不算“无关文件”
const TOLERATED_IN_DEST = [".git", ".idea", "LICENSE"];

// 目标里如果已有用户数据，明确报警（脚本不会删除它，但发布前必须自己确认没被提交）
let hazardsInDest = [];
if (existsSync(dest)) {
  const listing = await readdir(dest).catch(() => []);
  hazardsInDest = listing.filter((name) => NEVER.includes(name) && name !== ".git");
  const hasForeignFiles = listing.some((name) => !TOLERATED_IN_DEST.includes(name) && !INCLUDE.includes(name));
  if (listing.length && hasForeignFiles && !force) {
    console.error(`目标目录 ${dest} 已有其它文件；确认无误后加 --force 再执行`);
    console.error(`现有内容：${listing.join(", ")}`);
    process.exit(2);
  }
}

if (!dryRun) await mkdir(dest, { recursive: true });
for (const item of INCLUDE) await copyTree(item);

console.log(`目标：${dest}${dryRun ? "（--dry，未写入）" : ""}`);
console.log(`将复制 ${copied.length} 个文件`);
if (skipped.length) console.warn(`已跳过 ${skipped.length} 个不该发布的文件：${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? " …" : ""}`);
if (missing.length) console.warn(`白名单里这些条目在源目录不存在：${missing.join(", ")}`);
if (hazardsInDest.length) console.warn(`注意：目标目录已存在 ${hazardsInDest.join(", ")}，本脚本不会删除它们，提交前请确认已被 .gitignore 排除`);
