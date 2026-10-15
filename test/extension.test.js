import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * 用 mock 的 chrome 与 fetch 跑扩展后台脚本，返回它内部的处理函数。
 * 只编译仓库自带的 extension/background.js（路径与文件名固定，不含任何外部输入），
 * 目的是在没有浏览器的情况下验证菜单逻辑与请求载荷。
 */
function loadBackground(chrome, fetchImpl) {
  const src = readFileSync(join(ROOT, "extension/background.js"), "utf8");
  const factory = new Function("chrome", "fetch", `${src}
;return { handleMenu, registerMenus, getSettings, buildPayload, MENUS };`);
  return factory(chrome, fetchImpl);
}

function mockChrome(storage = {}) {
  const menus = [];
  const notifications = [];
  const tabs = [];
  const handlers = {};
  const chrome = {
    storage: {
      local: {
        get: async (keys) => Object.fromEntries(keys.filter((key) => storage[key] !== undefined).map((key) => [key, storage[key]])),
        set: async (value) => Object.assign(storage, value),
      },
    },
    contextMenus: {
      removeAll: (done) => {
        menus.length = 0;
        done?.();
      },
      create: (item) => menus.push(item),
      onClicked: { addListener: (fn) => (handlers.menuClicked = fn) },
    },
    notifications: {
      create: (id, options) => notifications.push({ id, ...options }),
      clear: (id) => notifications.push({ id, cleared: true }),
      onClicked: { addListener: (fn) => (handlers.notificationClicked = fn) },
    },
    tabs: { create: (options) => tabs.push(options) },
    runtime: {
      onInstalled: { addListener: (fn) => (handlers.installed = fn) },
      onStartup: { addListener: (fn) => (handlers.startup = fn) },
    },
  };
  return { chrome, menus, notifications, tabs, handlers };
}

let server;
let baseUrl;
let notesDir;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "todo-ext-"));
  notesDir = join(dir, "notes");
  process.env.TODO_NO_LISTEN = "1";
  process.env.TODO_DATA_FILE = join(dir, "tasks.json");
  process.env.TODO_NOTES_DIR = notesDir;
  const module = await import("../server.js");
  server = module.server;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

const getJson = async (path) => (await fetch(baseUrl + path)).json();

test("manifest 是合规的 MV3 且只申请必要权限", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "extension/manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(typeof manifest.background.service_worker, "string");
  assert.deepEqual(manifest.permissions.sort(), ["contextMenus", "notifications", "storage"]);
  assert.deepEqual(
    manifest.host_permissions,
    ["http://127.0.0.1/*", "http://localhost/*"],
    "只允许访问本机，绝不申请 <all_urls>"
  );
  for (const file of ["manifest.json", manifest.background.service_worker, manifest.action.default_popup, "options.js", "options.css"]) {
    assert.ok(readFileSync(join(ROOT, "extension", file), "utf8").length > 0, `${file} 必须存在且非空`);
  }
  for (const [size, path] of Object.entries(manifest.icons)) assert.ok(readFileSync(join(ROOT, "extension", path)), `图标 ${size}`);
  assert.equal(manifest.action.default_popup, "options.html");
  assert.ok(!/<script[^>]*>(?!<\/script>)/i.test(readFileSync(join(ROOT, "extension", manifest.action.default_popup), "utf8")), "扩展页面不得使用内联脚本");
});

test("加载即注册四个右键菜单项", () => {
  const { chrome, menus } = mockChrome();
  loadBackground(chrome, fetch);
  assert.deepEqual(menus.map((m) => m.id), ["clip-selection", "clip-page", "clip-image", "open-app"]);
  assert.deepEqual(menus[0].contexts, ["selection"], "选中文字菜单只出现在有选区时");
  assert.deepEqual(menus[1].contexts, ["page", "link"]);
  assert.deepEqual(menus[2].contexts, ["image"]);
  assert.ok(menus.every((m) => m.title && m.title.length <= 40), "菜单文案存在且不过长");
});

test("三种菜单采集不同字段", () => {
  const { chrome } = mockChrome();
  const bg = loadBackground(chrome, fetch);
  const info = { pageTitle: "某文档", pageUrl: "https://example.com/doc?x=1", selectionText: "选中的两句话", srcUrl: "https://example.com/a.png", linkUrl: "https://example.com/out" };
  assert.deepEqual(bg.buildPayload("clip-selection", info), { title: "某文档", url: "https://example.com/out", text: "选中的两句话" });
  assert.deepEqual(bg.buildPayload("clip-page", info), { title: "某文档", url: "https://example.com/out", text: "" });
  assert.deepEqual(bg.buildPayload("clip-image", info), { title: "某文档", url: "https://example.com/out", image: "https://example.com/a.png", text: "" });
  assert.deepEqual(bg.buildPayload("clip-page", {}, { title: "标签页", url: "https://a.b" }), { title: "标签页", url: "https://a.b", text: "" }, "缺少右键信息时回退到标签页");
});

test("未选中文字时不请求服务，只提示", async () => {
  const { chrome, notifications } = mockChrome({ baseUrl });
  const bg = loadBackground(chrome, async () => {
    throw new Error("不该发起请求");
  });
  await bg.handleMenu("clip-selection", { pageTitle: "页面", pageUrl: "https://example.com", selectionText: "" }, {});
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].title, /没有可剪藏/);
});

test("端到端：两次剪藏先建笔记再追加", async () => {
  const { chrome, notifications } = mockChrome({ baseUrl });
  const bg = loadBackground(chrome, fetch);

  await bg.handleMenu("clip-selection", { pageTitle: "前端性能优化指南", pageUrl: "https://example.com/a", selectionText: "第一段摘录内容\n第二段摘录内容" }, {});
  const list1 = await getJson("/api/notes");
  assert.equal(list1.total, 1, "第一次剪藏自动建笔记");
  assert.equal(list1.notes[0].title, "网页剪藏");
  assert.deepEqual(list1.notes[0].tags, ["剪藏"]);
  assert.equal(notifications.at(-1).title, "已剪藏");
  assert.match(notifications.at(-1).message, /新建笔记/);

  await bg.handleMenu("clip-page", { pageTitle: "缓存最佳实践", pageUrl: "https://example.com/b" }, {});
  const list2 = await getJson("/api/notes");
  assert.equal(list2.total, 1, "第二次应追加而不是新建");
  assert.equal(list2.notes[0].file, "网页剪藏");
  const detail = await getJson(`/api/notes/${list2.notes[0].id}`);
  assert.match(detail.body, /# 网页剪藏/);
  assert.match(detail.body, /### 前端性能优化指南/);
  assert.match(detail.body, /- 来源：<https:\/\/example\.com\/a>/);
  assert.match(detail.body, /> 第一段摘录内容\n> 第二段摘录内容/, "多行摘录按引用块逐行加前缀");
  assert.match(detail.body, /### 缓存最佳实践/);
  assert.equal((detail.body.match(/### /g) ?? []).length, 2);

  const page = await getJson("/api/notes?q=" + encodeURIComponent("缓存"));
  assert.equal(page.notes.length, 1, "剪藏内容可被主界面全文搜索命中");
});

test("剪藏写入指定的目标笔记", async () => {
  const { chrome } = mockChrome({ baseUrl, note: "取货单参考" });
  const bg = loadBackground(chrome, fetch);
  await bg.handleMenu("clip-page", { pageTitle: "某页", pageUrl: "https://example.com/c" }, {});
  const list = await getJson("/api/notes");
  const titles = list.notes.map((n) => n.title);
  assert.ok(titles.includes("取货单参考"), JSON.stringify(titles));
  const note = list.notes.find((n) => n.title === "取货单参考");
  assert.equal(note.file, "取货单参考");
});

test("点击剪藏成功的通知会打开笔记页", async () => {
  const mock = mockChrome({ baseUrl });
  const bg = loadBackground(mock.chrome, fetch);
  await bg.handleMenu("clip-page", { pageTitle: "通知测试页", pageUrl: "https://example.com/e" }, {});
  const last = mock.notifications.at(-1);
  assert.equal(last.title, "已剪藏");
  assert.equal(typeof mock.handlers.notificationClicked, "function");
  await mock.handlers.notificationClicked(last.id);
  assert.deepEqual(mock.tabs.at(-1), { url: `${baseUrl}/?view=notes` });
  assert.equal(mock.notifications.at(-1).cleared, true, "点完即清除通知");
});

test("服务没在运行时提示可操作的原因", async () => {
  const { chrome, notifications, tabs } = mockChrome({ baseUrl: "http://127.0.0.1:1" });
  const bg = loadBackground(chrome, fetch);
  await bg.handleMenu("clip-page", { pageTitle: "某页", pageUrl: "https://example.com" }, {});
  assert.match(notifications.at(-1).title, /剪藏失败/);
  assert.match(notifications.at(-1).message, /node server\.js/);

  await bg.handleMenu("open-app", {}, {});
  assert.deepEqual(tabs, [{ url: "http://127.0.0.1:1/?view=notes" }], "open-app 只开页面不请求");
});

test("地址与笔记名可从设置弹窗改写并规范化", async () => {
  const storage = {};
  const { chrome } = mockChrome(storage);
  const bg = loadBackground(chrome, fetch);
  assert.deepEqual(await bg.getSettings(), { baseUrl: "http://127.0.0.1:8787", note: "网页剪藏" }, "默认值");

  await chrome.storage.local.set({ baseUrl: `${baseUrl}/`, note: "  收藏  " });
  const overridden = await bg.getSettings();
  assert.equal(overridden.baseUrl, baseUrl, "结尾斜杠被去掉");
  assert.equal(overridden.note, "收藏", "首尾空格被去掉");

  const second = mockChrome({ baseUrl, note: "收藏" });
  const bg2 = loadBackground(second.chrome, fetch);
  assert.deepEqual(await bg2.getSettings(), { baseUrl, note: "收藏" });
  await bg2.handleMenu("clip-page", { pageTitle: "另一页", pageUrl: "https://example.com/d" }, {});
  assert.equal(second.notifications.at(-1)?.title, "已剪藏");
  const list = await getJson("/api/notes");
  assert.ok(list.notes.some((n) => n.title === "收藏"), "写入到自定义笔记");
});
