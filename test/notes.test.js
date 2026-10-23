import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { NotesError, NotesLibrary, clipBlock, countWords, inferTitle, parseFrontMatter, parseTags, plainExcerpt, serializeNote, slugTitle } from "../lib/notes.js";

async function freshLib() {
  const dir = await mkdtemp(join(tmpdir(), "todo-notes-"));
  return { lib: new NotesLibrary(dir), dir };
}

test("文件名清洗：保留中文与全角标点，剔除 Windows 非法字符与穿越片段", () => {
  assert.equal(slugTitle("周会 记录/2026"), "周会 记录-2026");
  assert.equal(slugTitle('a:b*c?"d|e'), "a-b-c-d-e");
  assert.equal(slugTitle("会议记录（改）v2 [重要]"), "会议记录（改）v2 [重要]");
  assert.equal(slugTitle("..\\..\\windows"), "windows");
  assert.equal(slugTitle("   "), "note");
  assert.equal(slugTitle("...."), "note");
  assert.match(slugTitle("x".repeat(200)), /^x{1,80}$/);
});

test("front matter 往返解析；外部纯 Markdown 也能识别", () => {
  const meta = { id: "n_1", title: "读书", tags: ["阅读", "重要"], pinned: true, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" };
  const parsed = parseFrontMatter(serializeNote(meta, "正文\n第二行\n"));
  assert.deepEqual(parsed.meta, meta);
  assert.equal(parsed.body, "正文\n第二行\n");

  const noFm = parseFrontMatter("# 外部笔记\n\n直接写的 Markdown");
  assert.equal(noFm.meta, null);
  assert.equal(inferTitle(noFm.body, "whatever.md"), "外部笔记");
  assert.equal(inferTitle("普通段落开头", "随手记.md"), "普通段落开头");
  assert.equal(inferTitle("", "文件名.md"), "文件名");
  assert.deepEqual(parseTags("[a, b ，c；d]"), ["a", "b", "c", "d"]);
  assert.deepEqual(parseTags("单标签"), ["单标签"]);
  assert.equal(plainExcerpt("# 标题\n- [ ] 事项\n`code` [链接](http://x)"), "标题 事项 code 链接");
  assert.ok(countWords("中文 abc def") > 0);
});

test("创建/读取：文件名来自标题，重名自动加后缀", async () => {
  const { lib, dir } = await freshLib();
  const a = await lib.create({ title: "会议记录", body: "第一次会议", tags: "周会, 重要" });
  assert.equal(a.note.title, "会议记录");
  assert.deepEqual(a.note.tags, ["周会", "重要"]);
  assert.match(a.note.id, /^n_/);
  assert.equal(a.note.file, "会议记录");

  const b = await lib.create({ title: "会议记录", body: "第二次" });
  assert.equal(b.note.file, "会议记录-2");
  assert.notEqual(b.note.id, a.note.id);

  const files = (await readdir(dir)).sort();
  assert.deepEqual(files, ["会议记录-2.md", "会议记录.md"]);
  const raw = await readFile(join(dir, "会议记录.md"), "utf8");
  assert.match(raw, /^---\nid: n_/);
  assert.match(raw, /第一次会议/);

  const fetched = await lib.get(a.note.id);
  assert.equal(fetched.body, "第一次会议");
});

test("更新：改标题会重命名文件并删除旧文件；只改正文保持原文件", async () => {
  const { lib, dir } = await freshLib();
  const created = await lib.create({ title: "旧标题", body: "内容" });
  const renamed = await lib.update(created.note.id, { title: "新标题" });
  assert.equal(renamed.note.file, "新标题");
  assert.equal(renamed.note.id, created.note.id, "改标题不应换 id");
  assert.deepEqual(await readdir(dir), ["新标题.md"]);

  const edited = await lib.update(created.note.id, { body: "改过的内容", pinned: true });
  assert.equal(edited.note.file, "新标题");
  assert.equal(edited.body, "改过的内容");
  assert.equal(edited.note.pinned, true);
  assert.ok(String(edited.note.updatedAt) >= String(created.note.updatedAt));
  assert.equal(edited.note.createdAt, created.note.createdAt, "创建时间保持不变");
});

for (const caseSensitive of [false, true]) {
  test(`仅大小写改标题：${caseSensitive ? "模拟大小写敏感目录" : "实际临时目录"}保留唯一有效文件`, async (t) => {
    const { lib, dir } = await freshLib();
    const entry = await lib.create({ title: "Draft", body: "初稿" });
    if (caseSensitive) {
      // 用独立物理路径模拟 draft.md，避免依赖宿主目录的大小写设置。
      const target = join(dir, "draft.md");
      const backingName = "case-sensitive-target.md";
      const mapPath = (path) => path === target ? join(dir, backingName) : path;
      for (const method of ["readFile", "stat", "unlink"]) {
        const original = fs[method];
        t.mock.method(fs, method, (path, ...args) => original(mapPath(path), ...args));
      }
      const originalRename = fs.rename;
      const originalReaddir = fs.readdir;
      t.mock.method(fs, "rename", (from, to) => originalRename(mapPath(from), mapPath(to)));
      t.mock.method(fs, "readdir", async (path, ...args) => {
        const names = await originalReaddir(path, ...args);
        return path === dir ? names.map((name) => name === backingName ? "draft.md" : name) : names;
      });
      syncBuiltinESMExports();
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    }
    const updated = await lib.update(entry.note.id, { title: "draft", body: "新稿", baseRevision: entry.note.revision });
    assert.equal(updated.note.title, "draft");
    assert.equal(updated.note.id, entry.note.id);
    assert.equal(updated.body, "新稿");
    if (caseSensitive) assert.equal(updated.note.file, "draft");
    assert.deepEqual(await readdir(dir), [`${updated.note.file}.md`]);
    const parsed = parseFrontMatter(await readFile(join(dir, `${updated.note.file}.md`), "utf8"));
    assert.equal(parsed.meta.title, "draft");
    assert.equal(parsed.meta.id, entry.note.id);
    assert.equal(parsed.body, "新稿");
    assert.equal((await lib.list()).total, 1);
    assert.equal((await lib.get(entry.note.id)).body, "新稿");
  });
}

test("外部编辑器改动在下次读取时立即可见", async () => {
  const { lib, dir } = await freshLib();
  const created = await lib.create({ title: "外部改", body: "原内容" });
  const path = join(dir, "外部改.md");
  await writeFile(path, await readFile(path, "utf8").then((t) => t.replace("原内容", "外部编辑器写入的内容")), "utf8");
  const read = await lib.get(created.note.id);
  assert.equal(read.body, "外部编辑器写入的内容");
  const { notes } = await lib.list();
  assert.equal(notes[0].excerpt, "外部编辑器写入的内容");
});

test("无 front matter 的既有 .md 直接入库可见，首次更新后补齐元数据", async () => {
  const { lib, dir } = await freshLib();
  await writeFile(join(dir, "导入前就有.md"), "# 导入前就有\n\n正文内容\n", "utf8");
  const { notes } = await lib.list();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, "导入前就有");
  assert.equal(notes[0].id, "导入前就有");

  const updated = await lib.update("导入前就有", { tags: ["旧"] });
  assert.equal(updated.note.file, "导入前就有");
  const raw = await readFile(join(dir, "导入前就有.md"), "utf8");
  assert.match(raw, /^---\nid: /);
});

test("列表排序、筛选与命中片段", async () => {
  const { lib } = await freshLib();
  await lib.create({ title: "A 项目预算", body: "提到 预算 与 财务", tags: ["财务"], updatedAt: "2026-10-01T00:00:00.000Z" });
  await lib.create({ title: "B 菜谱", body: "红烧肉 做法 详细", tags: "生活", updatedAt: "2026-10-02T00:00:00.000Z" });
  const pinnedNote = await lib.create({ title: "C 置顶", body: "重要事项", pinned: true, updatedAt: "2026-10-03T00:00:00.000Z" });

  const all = await lib.list();
  assert.deepEqual(all.notes.map((n) => n.title), ["C 置顶", "B 菜谱", "A 项目预算"], "置顶优先，其次按更新时间倒序");
  assert.deepEqual(all.tags, ["生活", "财务"]);

  const byTag = await lib.list({ tag: "财务" });
  assert.deepEqual(byTag.notes.map((n) => n.title), ["A 项目预算"]);

  const onlyPinned = await lib.list({ pinned: "1" });
  assert.deepEqual(onlyPinned.notes.map((n) => n.title), ["C 置顶"]);
  assert.equal((await lib.list({ pinned: "0" })).notes.length, 2);

  const search = await lib.list({ q: "预算" });
  assert.equal(search.total, 1);
  assert.match(search.notes[0].hit, /预算/);
  assert.equal((await lib.list({ q: "不存在的词" })).total, 0);
  assert.equal(pinnedNote.note.pinned, true);
});

test("删除进回收站、可恢复、可彻底删除；单条与合集导出不受影响", async () => {
  const { lib, dir } = await freshLib();
  const a = await lib.create({ title: "待删除", body: "x" });
  await lib.create({ title: "保留", body: "内容保留", tags: ["归档"] });
  const removed = await lib.remove(a.note.id);
  assert.equal(removed.removed, a.note.id);
  assert.match(removed.trash, /^\d{8}-\d{6}(?:-[0-9a-f-]+)?__待删除\.md$/, removed.trash);
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith(".md")), ["保留.md"], "主目录只剩保留的笔记");
  await assert.rejects(() => lib.get(a.note.id), NotesError);
  assert.equal((await lib.list()).total, 1, "回收站内容不出现在列表");

  const trash = await lib.listTrash();
  assert.equal(trash.length, 1);
  assert.equal(trash[0].title, "待删除");
  assert.ok(trash[0].deletedAt, "记录删除时间");

  const restored = await lib.restoreTrash(trash[0].trashFile);
  assert.equal(restored.note.title, "待删除");
  assert.equal(restored.body, "x");
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith(".md")).sort(), ["保留.md", "待删除.md"]);
  assert.equal((await lib.listTrash()).length, 0);

  const again = await lib.create({ title: "再删一次", body: "y" });
  await lib.remove(again.note.id);
  const purged = await lib.purgeTrash((await lib.listTrash())[0].trashFile);
  assert.match(purged.purged, /再删一次/);
  assert.equal((await lib.listTrash()).length, 0);
  await assert.rejects(() => lib.purgeTrash("不存在"), /回收站/);

  const one = await lib.exportOne("保留");
  assert.equal(one.name, "保留.md");
  assert.match(one.text, /^---\nid: n_/);

  const all = await lib.exportAll();
  assert.match(all.name, /^notes-\d{4}-\d{2}-\d{2}\.md$/);
  assert.equal(all.count, 2, "恢复后的两条都在合集里");
  assert.match(all.text, /笔记合集（2 条）/);
  assert.match(all.text, /内容保留/);
});

test("回收站按保留天数清理，且只认带时间戳的文件", async () => {
  const { lib, dir } = await freshLib();
  const note = await lib.create({ title: "过期条目", body: "z" });
  const old = new Date(Date.now() - 9 * 86_400_000);
  await lib.remove(note.note.id, old);
  const fresh = await lib.create({ title: "新条目", body: "w" });
  await lib.remove(fresh.note.id);

  const trashDir = join(dir, "_trash");
  await writeFile(join(trashDir, "手工放的.md"), "# 手工\n\n不该被清理");

  // 第二次 remove 已触发自动清理：超期条目不该还在
  assert.deepEqual((await lib.listTrash()).map((t) => t.originalFile).sort(), ["手工放的", "新条目"], "超期条目在删除时已被自动清理");
  const removed = await lib.pruneTrash(new Date(), 7);
  assert.deepEqual(removed, [], "手动再清理应无新增删除");
  const left = (await readdir(trashDir)).sort();
  assert.equal(left.length, 2);
  assert.ok(left.some((f) => f.includes("新条目")) && left.includes("手工放的.md"), left.join(","));
  assert.equal((await lib.listTrash()).length, 2, "无戳文件也能列出（删除时间未知）");
});

test("导入：识别中文名、跳过重复与非 Markdown", async () => {
  const { lib } = await freshLib();
  await lib.create({ title: "已有笔记", body: "同样内容" });
  const result = await lib.importMany([
    { name: "新笔记.md", content: "# 新笔记\n\n导入的正文\n" },
    { name: "无标题片段.txt", content: "只有一行文本" },
    { name: "已有笔记.md", content: "# 已有笔记\n\n同样内容\n" },
    { name: "照片.png", content: "binary?" },
    { name: "../逃逸.md", content: "# 逃逸\n\n不该写到这里" },
  ]);
  assert.deepEqual(result.created.map((c) => c.title), ["新笔记", "只有一行文本", "逃逸"]);
  assert.equal(result.created[1].file, "只有一行文本");
  assert.deepEqual(result.skipped.map((s) => s.name), ["已有笔记.md", "照片.png"]);
  assert.match(result.skipped[0].reason, /已存在/);
  const { notes } = await lib.list();
  assert.equal(notes.length, 4, "原有 1 条 + 导入 3 条");
  assert.ok(notes.every((n) => !String(n.file).includes("..")), "导入文件名不得包含路径片段");
});

test("剪藏片段：消毒、逐行引用与长度上限", () => {
  const block = clipBlock({ title: "含 # 井号 的标题", url: "https://example.com/a?b=1>c", text: "  多余  空格 \n\n 第二行  " }, new Date("2026-10-14T09:07:00"));
  assert.match(block, /^### 含 \\# 井号 的标题/, "标题里的 # 需转义以免变成标题");
  assert.match(block, /- 时间：2026-10-14 09:07/);
  assert.match(block, /- 来源：<https:\/\/example\.com\/a\?b=1c>/, "URL 内的 > 会被去掉以免破坏引用");
  assert.equal(block.includes("\n> 多余 空格\n> 第二行"), true, "压缩空格并逐行加引用前缀");

  const huge = clipBlock({ title: "长", text: "字".repeat(5000) });
  assert.ok(huge.length < 2200, `摘录应被截断，实际 ${huge.length}`);

  const control = clipBlock({ title: "控制字符\u0000\u0007", url: "", text: "" });
  assert.equal(control.includes("\u0000"), false);
  assert.match(control, /^### 控制字符/);
  assert.equal(clipBlock({ title: "", url: "https://only.url" }).includes("### https://only.url"), true, "无标题时退回 URL");
});

test("空正文笔记落到默认标题，非法 id 返回 404", async () => {
  const { lib } = await freshLib();
  const blank = await lib.create({ title: "   ", body: "" });
  assert.equal(blank.note.title, "无标题");
  const err = await lib.remove("不存在的笔记").catch((e) => e);
  assert.ok(err instanceof NotesError);
  assert.equal(err.status, 404);
  const traversal = await lib.get("../../server").catch((e) => e);
  assert.equal(traversal.status, 404, "路径穿越式 id 只会当成不存在的笔记");
});

function assertConflict(error) {
  assert.ok(error instanceof NotesError);
  assert.equal(error.status, 409);
  assert.equal(error.code, "NOTE_CONFLICT");
  assert.match(error.message, /版本冲突/);
  assert.match(error.message, /保留.*草稿/);
  return true;
}

test("并发同名创建：每条笔记有独立文件且正文不丢失", async () => {
  const { lib } = await freshLib();
  const entries = await Promise.all(Array.from({ length: 12 }, (_, i) => lib.create({ title: "同名", body: `正文-${i}` })));
  assert.equal(new Set(entries.map((e) => e.note.id)).size, 12);
  assert.equal(new Set(entries.map((e) => e.note.file)).size, 12);
  assert.equal((await lib.list()).total, 12);
  for (let i = 0; i < entries.length; i += 1) {
    assert.equal((await lib.get(entries[i].note.id)).body, `正文-${i}`);
  }
});

test("并发剪藏：首次仅建一个笔记，后续追加全部保留", async () => {
  const { lib } = await freshLib();
  for (let round = 0; round < 2; round += 1) {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => lib.appendClip({ noteTitle: "收集", title: `页面-${round}-${i}`, text: `摘录-${round}-${i}` })));
    assert.equal(results.filter((r) => r.created).length, round === 0 ? 1 : 0);
    assert.equal(new Set(results.map((r) => r.note.id)).size, 1);
  }
  const { notes } = await lib.list();
  assert.equal(notes.length, 1);
  const { body } = await lib.get(notes[0].id);
  assert.equal((body.match(/^### 页面-/gm) ?? []).length, 24);
  for (let round = 0; round < 2; round += 1) {
    for (let i = 0; i < 12; i += 1) assert.ok(body.includes(`> 摘录-${round}-${i}\n`));
  }
});

test("revision 为原始 Markdown SHA256；并发旧版本只允许一次提交", async () => {
  const { lib, dir } = await freshLib();
  const first = await lib.create({ title: "版本", body: "初稿" });
  const raw = await readFile(join(dir, `${first.note.file}.md`));
  assert.equal(first.note.revision, createHash("sha256").update(raw).digest("hex"));
  assert.equal((await lib.get(first.note.id)).note.revision, first.note.revision);
  assert.equal((await lib.list()).notes[0].revision, first.note.revision);
  const results = await Promise.allSettled([
    lib.update(first.note.id, { body: "新稿", baseRevision: first.note.revision }),
    lib.update(first.note.id, { body: "旧客户端", baseRevision: first.note.revision }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assertConflict(results[1].reason);
  assert.notEqual(results[0].value.note.revision, first.note.revision);
  assert.equal((await lib.get(first.note.id)).body, "新稿");
  await assert.rejects(lib.update(first.note.id, { body: "再覆盖", baseRevision: first.note.revision }), assertConflict);
  await lib.update(first.note.id, { body: "未传版本的内部调用" });
  assert.equal((await lib.get(first.note.id)).body, "未传版本的内部调用");
});

test("外部编辑仅改变换行也使 revision 失效，冲突不调用备份钩子", async () => {
  const { lib, dir } = await freshLib();
  const entry = await lib.create({ title: "外部版本", body: "原文\n" });
  const file = join(dir, `${entry.note.file}.md`);
  const external = (await readFile(file, "utf8")).replace(/\n/g, "\r\n");
  await writeFile(file, external);
  let calls = 0;
  lib.onWrite = () => { calls += 1; };
  await assert.rejects(lib.update(entry.note.id, { body: "覆盖", baseRevision: entry.note.revision }), assertConflict);
  assert.equal(calls, 0);
  assert.equal(await readFile(file, "utf8"), external);
  const current = await lib.get(entry.note.id);
  assert.equal(current.note.revision, createHash("sha256").update(external).digest("hex"));
  await lib.update(entry.note.id, { body: "已合并", baseRevision: current.note.revision });
  assert.equal(calls, 1);
});

for (const renamed of [false, true]) {
  for (const withRevision of [false, true]) {
    test(`备份钩子直接改写原稿：${renamed ? "改名" : "不改名"}/${withRevision ? "带" : "不带"} baseRevision 拒绝覆盖并可重试`, async () => {
      const { lib, dir } = await freshLib();
      const entry = await lib.create({ title: "备份竞态", body: "初稿\n" });
      const file = join(dir, `${entry.note.file}.md`);
      const external = Buffer.from((await readFile(file, "utf8")).replace("初稿", "外部新稿").replace(/\n/g, "\r\n"));
      let calls = 0;
      lib.onWrite = async () => { if (++calls === 1) await writeFile(file, external); };
      const patch = { title: renamed ? "改名后" : entry.note.title, body: "本地草稿" };
      if (withRevision) patch.baseRevision = entry.note.revision;
      await assert.rejects(lib.update(entry.note.id, patch), assertConflict);
      assert.equal(calls, 1);
      assert.deepEqual(await readFile(file), external, "必须保留外部原始字节");
      assert.deepEqual(await readdir(dir), [`${entry.note.file}.md`], "不得留下新文件或自身 tmp");
      const current = await lib.get(entry.note.id);
      assert.equal(current.note.title, entry.note.title);
      assert.equal(current.body, "外部新稿\r\n");
      assert.equal(current.note.revision, createHash("sha256").update(external).digest("hex"));
      assert.notEqual(current.note.revision, entry.note.revision);
      const retried = await lib.update(entry.note.id, { ...patch, body: "已合并", baseRevision: current.note.revision });
      assert.equal(calls, 2);
      assert.equal(retried.note.id, entry.note.id);
      assert.equal(retried.note.title, patch.title);
      assert.equal(retried.body, "已合并");
      assert.deepEqual(await readdir(dir), [`${retried.note.file}.md`]);
      assert.equal((await lib.get(entry.note.id)).body, "已合并");
      assert.equal((await lib.list()).total, 1);
    });
  }

  test(`备份期间原稿被删除：${renamed ? "改名" : "不改名"}返回版本冲突且不复活原稿`, async () => {
    const { lib, dir } = await freshLib();
    const entry = await lib.create({ title: "被外部删除", body: "初稿" });
    lib.onWrite = () => fs.unlink(join(dir, `${entry.note.file}.md`));
    await assert.rejects(lib.update(entry.note.id, {
      title: renamed ? "改名后" : entry.note.title,
      body: "不应写入",
      baseRevision: entry.note.revision,
    }), assertConflict);
    assert.deepEqual(await readdir(dir), [], "不能留下原稿、新稿或自身 tmp");
  });
}

test("临时文件写入后复查原始字节，不能用解码后的正文代替 SHA256", async (t) => {
  const { lib, dir } = await freshLib();
  const entry = await lib.create({ title: "临时写入竞态", body: "初稿" });
  const file = join(dir, `${entry.note.file}.md`);
  const raw = await readFile(file);
  await writeFile(file, Buffer.concat([raw, Buffer.from([0xff])]));
  const current = await lib.get(entry.note.id);
  const external = Buffer.concat([raw, Buffer.from([0xfe])]);
  const originalWriteFile = fs.writeFile;
  t.mock.method(fs, "writeFile", async (path, ...args) => {
    await originalWriteFile(path, ...args);
    if (path.startsWith(dir) && path.endsWith(".tmp")) await originalWriteFile(file, external);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(lib.update(entry.note.id, { body: "覆盖", baseRevision: current.note.revision }), assertConflict);
  assert.deepEqual(await readFile(file), external);
  assert.deepEqual(await readdir(dir), [`${entry.note.file}.md`]);
  t.mock.restoreAll();
  syncBuiltinESMExports();
  const latest = await lib.get(entry.note.id);
  assert.equal(latest.body, current.body, "不同非法 UTF-8 字节解码后相同，但 revision 不同");
  assert.notEqual(latest.note.revision, current.note.revision);
  assert.equal((await lib.update(entry.note.id, { body: "已合并", baseRevision: latest.note.revision })).body, "已合并");
});

test("EPERM rename 重试前也复查版本，外部新稿保留且新 revision 可重试", async (t) => {
  const { lib, dir } = await freshLib();
  const entry = await lib.create({ title: "重试竞态", body: "初稿" });
  const file = join(dir, `${entry.note.file}.md`);
  const external = (await readFile(file, "utf8")).replace("初稿", "重试期间外部新稿");
  const target = join(dir, "重试改名.md");
  const originalRename = fs.rename;
  let attempts = 0;
  t.mock.method(fs, "rename", async (from, to) => {
    if (to === target && ++attempts === 1) {
      await writeFile(file, external);
      throw Object.assign(new Error("临时占用"), { code: "EPERM" });
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(lib.update(entry.note.id, { title: "重试改名", body: "覆盖", baseRevision: entry.note.revision }), assertConflict);
  assert.equal(attempts, 1, "复查失败后不得再次 rename");
  assert.equal(await readFile(file, "utf8"), external);
  assert.deepEqual(await readdir(dir), [`${entry.note.file}.md`]);
  const current = await lib.get(entry.note.id);
  const retried = await lib.update(entry.note.id, { title: "重试改名", body: "已合并", baseRevision: current.note.revision });
  assert.equal(retried.note.id, entry.note.id);
  assert.equal(retried.body, "已合并");
  assert.equal(attempts, 2);
  assert.deepEqual(await readdir(dir), ["重试改名.md"]);
});

for (const creating of [false, true]) {
  test(`备份期间外部创建目标文件：${creating ? "新建" : "改名"}不能覆盖外部文件`, async () => {
    const { lib, dir } = await freshLib();
    const entry = await lib.create({ title: "原稿", body: "原正文" });
    const target = join(dir, "目标.md");
    lib.onWrite = () => writeFile(target, "外部独立笔记");
    await assert.rejects(creating
      ? lib.create({ title: "目标", body: "新建正文" })
      : lib.update(entry.note.id, { title: "目标", body: "改名正文", baseRevision: entry.note.revision }), assertConflict);
    assert.equal(await readFile(target, "utf8"), "外部独立笔记");
    assert.equal((await lib.get(entry.note.id)).body, "原正文");
    assert.deepEqual((await readdir(dir)).sort(), ["原稿.md", "目标.md"]);
  });
}

test("剪藏首次读取后外部改稿，不得把旧正文配上新版本覆盖", async (t) => {
  const { lib, dir } = await freshLib();
  const entry = await lib.create({ title: "剪藏竞态", body: "初稿" });
  const file = join(dir, `${entry.note.file}.md`);
  const external = (await readFile(file, "utf8")).replace("初稿", "外部新稿");
  const originalRead = fs.readFile;
  let changed = false;
  t.mock.method(fs, "readFile", async (path, ...args) => {
    const bytes = await originalRead(path, ...args);
    if (path === file && !changed) {
      changed = true;
      await writeFile(file, external);
    }
    return bytes;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(lib.appendClip({ noteTitle: "剪藏竞态", title: "页面", text: "摘录" }), assertConflict);
  assert.equal(await readFile(file, "utf8"), external);
  await lib.appendClip({ noteTitle: "剪藏竞态", title: "页面", text: "摘录" });
  const { body } = await lib.get(entry.note.id);
  assert.match(body, /^外部新稿/);
  assert.match(body, /> 摘录/);
});

test("文件占用返回 409 但不标记 NOTE_CONFLICT，清理 tmp 并保留原稿", async (t) => {
  const { lib, dir } = await freshLib();
  const entry = await lib.create({ title: "占用", body: "初稿" });
  const file = join(dir, `${entry.note.file}.md`);
  const raw = await readFile(file);
  let attempts = 0;
  t.mock.method(fs, "rename", async () => {
    attempts += 1;
    throw Object.assign(new Error("占用"), { code: "EPERM" });
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(lib.update(entry.note.id, { body: "覆盖", baseRevision: entry.note.revision }), (error) => {
    assert.ok(error instanceof NotesError);
    assert.equal(error.status, 409);
    assert.equal(error.code, undefined);
    assert.match(error.message, /占用/);
    return true;
  });
  assert.equal(attempts, 5);
  assert.deepEqual(await readFile(file), raw);
  assert.deepEqual(await readdir(dir), [`${entry.note.file}.md`]);
});

test("所有笔记变更先备份：钩子失败时原稿和回收站不变", async (t) => {
  for (const operation of ["create", "update", "remove", "restore", "purge", "prune", "autoPrune"]) {
    await t.test(operation, async () => {
      const { lib, dir } = await freshLib();
      const entry = await lib.create({ title: "受保护", body: "保留" });
      const old = new Date(Date.now() - 9 * 86_400_000);
      let removed;
      if (["restore", "purge", "prune", "autoPrune"].includes(operation)) removed = await lib.remove(entry.note.id, old);
      const active = operation === "autoPrune" ? await lib.create({ title: "新的", body: "新的原稿" }) : entry;
      const snapshot = async () => {
        const files = (await readdir(dir)).filter((n) => n.endsWith(".md"));
        const trash = await readdir(join(dir, "_trash")).catch((e) => { if (e.code === "ENOENT") return []; throw e; });
        return Promise.all([...files.map((n) => join(dir, n)), ...trash.map((n) => join(dir, "_trash", n))].sort().map(async (file) => [file, await readFile(file, "utf8")]));
      };
      const before = await snapshot();
      let calls = 0;
      lib.onWrite = async () => { calls += 1; throw new Error("备份失败"); };
      const actions = {
        create: () => lib.create({ title: "新建" }),
        update: () => lib.update(entry.note.id, { title: "改名", body: "覆盖" }),
        remove: () => lib.remove(entry.note.id),
        restore: () => lib.restoreTrash(removed.trash),
        purge: () => lib.purgeTrash(removed.trash),
        prune: () => lib.pruneTrash(),
        autoPrune: () => lib.remove(active.note.id),
      };
      await assert.rejects(actions[operation], /备份失败/);
      assert.equal(calls, 1);
      assert.deepEqual(await snapshot(), before);
      lib.onWrite = null;
      await lib.create({ title: "失败后仍可写入" });
    });
  }
});

test("自动 prune 自身也先 await 备份；无过期文件时不调用钩子", async () => {
  const { lib } = await freshLib();
  const old = await lib.create({ title: "过期" });
  const removed = await lib.remove(old.note.id, new Date(Date.now() - 9 * 86_400_000));
  const fresh = await lib.create({ title: "当前" });
  let calls = 0;
  lib.onWrite = async () => { if (++calls === 2) throw new Error("清理前备份失败"); };
  await assert.rejects(lib.remove(fresh.note.id), /清理前备份失败/);
  assert.ok((await lib.listTrash()).some((e) => e.trashFile === removed.trash));
  assert.equal(calls, 2);
  lib.onWrite = null;
  await lib.pruneTrash();
  lib.onWrite = () => { throw new Error("空清理不应备份"); };
  assert.deepEqual(await lib.pruneTrash(), []);
});

test("同秒同文件名删除不会覆盖；兼容旧回收站名称", async () => {
  const { lib, dir } = await freshLib();
  const at = new Date();
  const first = await lib.create({ title: "反复删除", body: "第一份" });
  const a = await lib.remove(first.note.id, at);
  const second = await lib.create({ title: "反复删除", body: "第二份" });
  const b = await lib.remove(second.note.id, at);
  assert.notEqual(a.trash, b.trash);
  const trash = await lib.listTrash();
  assert.equal(trash.length, 2);
  assert.ok(trash.every((e) => e.originalFile === "反复删除" && e.deletedAt));
  assert.equal((await lib.restoreTrash(a.trash)).body, "第一份");
  assert.equal((await lib.restoreTrash(b.trash)).body, "第二份");
  await writeFile(join(dir, "_trash", "20261014-090700__旧格式.md"), "# 旧格式\n");
  assert.equal((await lib.restoreTrash("20261014-090700__旧格式.md")).body, "# 旧格式\n");
});

test("恢复时已存在同 id 必须拒绝，不另建重复 id", async () => {
  const { lib } = await freshLib();
  const old = await lib.create({ title: "旧", body: "回收站原稿" });
  const removed = await lib.remove(old.note.id);
  await lib.create({ id: old.note.id, title: "现存", body: "当前原稿" });
  lib.onWrite = () => { throw new Error("冲突不应备份"); };
  await assert.rejects(lib.restoreTrash(removed.trash), (error) => error instanceof NotesError && error.status === 409);
  assert.equal((await lib.list()).total, 1);
  assert.equal((await lib.get(old.note.id)).body, "当前原稿");
  assert.equal((await lib.listTrash()).length, 1);
});

test("读取错误不能当作笔记不存在，避免剪藏覆盖未知内容", async () => {
  const { lib, dir } = await freshLib();
  await mkdir(join(dir, "不可读.md"));
  await assert.rejects(lib.list(), (error) => error.code !== "ENOENT");
  await assert.rejects(lib.appendClip({ noteTitle: "收集", text: "不得新建" }));
  assert.deepEqual(await readdir(dir), ["不可读.md"]);
});

test("改名后旧文件 unlink 失败：回滚新文件并保留唯一旧原稿", async (t) => {
  const { lib, dir } = await freshLib();
  const entry = await lib.create({ title: "旧原稿", body: "不能丢" });
  const file = join(dir, "旧原稿.md");
  const raw = await readFile(file, "utf8");
  const originalUnlink = fs.unlink;
  t.mock.method(fs, "unlink", async (path) => {
    if (path === file) throw Object.assign(new Error("旧文件被占用"), { code: "EACCES" });
    return originalUnlink(path);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(lib.update(entry.note.id, { title: "新原稿", body: "修改" }), /旧文件被占用/);
  assert.deepEqual(await readdir(dir), ["旧原稿.md"]);
  assert.equal(await readFile(file, "utf8"), raw);
});

test("公开读取等待已排队写入，内部剪藏/恢复/导入不嵌套死锁", { timeout: 5000 }, async () => {
  const { lib } = await freshLib();
  const entry = await lib.create({ title: "串行视图", body: "旧" });
  let release;
  let entered;
  const started = new Promise((r) => { entered = r; });
  const gate = new Promise((r) => { release = r; });
  lib.onWrite = async () => { entered(); await gate; };
  const writing = lib.update(entry.note.id, { body: "已提交" });
  await started;
  let settled = false;
  const reading = Promise.all([lib.get(entry.note.id), lib.list(), lib.exportOne(entry.note.id), lib.exportAll(), lib.listTrash()]).then((r) => { settled = true; return r; });
  try {
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(settled, false, "写入完成前不得返回旧视图");
  } finally {
    release();
    await writing;
  }
  const [one, list, exported, all] = await reading;
  assert.equal(one.body, "已提交");
  assert.equal(list.notes[0].excerpt, "已提交");
  assert.match(exported.text, /已提交/);
  assert.match(all.text, /已提交/);
  lib.onWrite = null;
  await lib.appendClip({ noteTitle: "串行视图", text: "追加" });
  const removed = await lib.remove(entry.note.id);
  await lib.restoreTrash(entry.note.id);
  assert.ok(removed.trash);
  await lib.importMany([{ name: "导入.md", content: "# 导入\n\n内容" }]);
});
