import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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

test("删除、单条导出与合集导出", async () => {
  const { lib, dir } = await freshLib();
  const a = await lib.create({ title: "待删除", body: "x" });
  await lib.create({ title: "保留", body: "内容保留", tags: ["归档"] });
  await lib.remove(a.note.id);
  assert.deepEqual(await readdir(dir), ["保留.md"]);
  await assert.rejects(() => lib.get(a.note.id), NotesError);

  const one = await lib.exportOne("保留");
  assert.equal(one.name, "保留.md");
  assert.match(one.text, /^---\nid: n_/);

  const all = await lib.exportAll();
  assert.match(all.name, /^notes-\d{4}-\d{2}-\d{2}\.md$/);
  assert.equal(all.count, 1);
  assert.match(all.text, /笔记合集（1 条）/);
  assert.match(all.text, /- \[保留\]\(#保留\)/);
  assert.match(all.text, /内容保留/);
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
