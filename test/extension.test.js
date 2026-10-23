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
async function loadBackground(chrome, fetchImpl) {
  const src = readFileSync(join(ROOT, "extension/background.js"), "utf8");
  // 只捕获脚本末尾 scheduleAlarms 发起的真实刷新，不额外刷新或靠延时猜测启动完成。
  const startupCall = /\nscheduleAlarms\(\);\s*$/;
  assert.match(src, startupCall);
  const instrumented = src.replace(startupCall, `
const refreshAtStartup = refreshBadge;
let startupRefresh;
refreshBadge = () => (startupRefresh = refreshAtStartup());
scheduleAlarms();
refreshBadge = refreshAtStartup;
`);
  const factory = new Function("chrome", "fetch", `${instrumented}
;return { handleMenu, registerMenus, getSettings, buildPayload, refreshBadge, MENUS, startupRefresh };`);
  const bg = factory(chrome, fetchImpl);
  bg.startupResult = await bg.startupRefresh;
  return bg;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function mockChrome(storage = {}, { tabUrls = [], createNotification = async () => {} } = {}) {
  const menus = [];
  const notifications = [];
  const notificationAttempts = [];
  const tabs = [];
  const badges = [];
  const alarms = [];
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
      create: (id, options) => {
        notificationAttempts.push({ id, ...options });
        const created = Promise.resolve().then(() => createNotification(id, options)).then(() => {
          notifications.push({ id, ...options });
          return id;
        });
        // 仍向调用者返回 rejected promise，同时避免旧实现的未处理拒绝污染其他用例。
        created.catch(() => {});
        return created;
      },
      clear: (id) => notifications.push({ id, cleared: true }),
      onClicked: { addListener: (fn) => (handlers.notificationClicked = fn) },
    },
    tabs: {
      create: (options) => tabs.push(options),
      query: async () => tabUrls.map((url) => ({ url })),
    },
    action: {
      setBadgeText: (options) => badges.push(options.text),
      setBadgeBackgroundColor: () => {},
    },
    alarms: {
      create: (name, options) => alarms.push({ name, ...options }),
      onAlarm: { addListener: (fn) => (handlers.alarm = fn) },
    },
    runtime: {
      onInstalled: { addListener: (fn) => (handlers.installed = fn) },
      onStartup: { addListener: (fn) => (handlers.startup = fn) },
    },
  };
  return { chrome, menus, notifications, notificationAttempts, tabs, badges, alarms, handlers, tabUrls };
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
  process.env.TODO_BACKUP_DIR = join(dir, "backups");
  process.env.TODO_SEED = "0";
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
  assert.deepEqual(manifest.permissions.sort(), ["alarms", "contextMenus", "notifications", "storage"]);
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

test("加载即注册四个右键菜单项", async () => {
  const { chrome, menus } = mockChrome({ baseUrl });
  await loadBackground(chrome, fetch);
  assert.deepEqual(menus.map((m) => m.id), ["clip-selection", "clip-page", "clip-image", "open-app"]);
  assert.deepEqual(menus[0].contexts, ["selection"], "选中文字菜单只出现在有选区时");
  assert.deepEqual(menus[1].contexts, ["page", "link"]);
  assert.deepEqual(menus[2].contexts, ["image"]);
  assert.ok(menus.every((m) => m.title && m.title.length <= 40), "菜单文案存在且不过长");
});

test("三种菜单采集不同字段", async () => {
  const { chrome } = mockChrome({ baseUrl });
  const bg = await loadBackground(chrome, fetch);
  const info = { pageTitle: "某文档", pageUrl: "https://example.com/doc?x=1", selectionText: "选中的两句话", srcUrl: "https://example.com/a.png", linkUrl: "https://example.com/out" };
  assert.deepEqual(bg.buildPayload("clip-selection", info), { title: "某文档", url: "https://example.com/out", text: "选中的两句话" });
  assert.deepEqual(bg.buildPayload("clip-page", info), { title: "某文档", url: "https://example.com/out", text: "" });
  assert.deepEqual(bg.buildPayload("clip-image", info), { title: "某文档", url: "https://example.com/out", image: "https://example.com/a.png", text: "" });
  assert.deepEqual(bg.buildPayload("clip-page", {}, { title: "标签页", url: "https://a.b" }), { title: "标签页", url: "https://a.b", text: "" }, "缺少右键信息时回退到标签页");
});

test("未选中文字时不请求服务，只提示", async () => {
  const { chrome, notifications } = mockChrome({ baseUrl });
  const bg = await loadBackground(chrome, async () => {
    throw new Error("不该发起请求");
  });
  await bg.handleMenu("clip-selection", { pageTitle: "页面", pageUrl: "https://example.com", selectionText: "" }, {});
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].title, /没有可剪藏/);
});

test("端到端：两次剪藏先建笔记再追加", async () => {
  const { chrome, notifications } = mockChrome({ baseUrl });
  const bg = await loadBackground(chrome, fetch);

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
  const bg = await loadBackground(chrome, fetch);
  await bg.handleMenu("clip-page", { pageTitle: "某页", pageUrl: "https://example.com/c" }, {});
  const list = await getJson("/api/notes");
  const titles = list.notes.map((n) => n.title);
  assert.ok(titles.includes("取货单参考"), JSON.stringify(titles));
  const note = list.notes.find((n) => n.title === "取货单参考");
  assert.equal(note.file, "取货单参考");
});

function localDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function makeDueTask(title) {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, due: localDate(), dueTime: "00:01", remindMinutes: 0 }),
  });
  return (await res.json()).task;
}

async function dropTask(id) {
  await fetch(`${baseUrl}/api/tasks/${id}/trash`, { method: "POST" });
  await fetch(`${baseUrl}/api/tasks/${id}/purge`, { method: "POST" });
}

test("角标显示待提醒数量，并注册 5 分钟定时", async (t) => {
  const task = await makeDueTask("角标验证任务");
  t.after(() => dropTask(task.id));
  const mock = mockChrome({ baseUrl });
  const bg = await loadBackground(mock.chrome, fetch);
  const result = bg.startupResult;
  assert.equal(result.online, true);
  assert.ok(result.count >= 1, JSON.stringify(result));
  assert.equal(mock.badges.at(-1), String(result.count), "角标数字应等于待提醒条数");
  assert.ok(mock.alarms.some((a) => a.name === "local-task-remind" && a.periodInMinutes === 5), "应注册定时刷新");
  assert.equal(typeof mock.handlers.alarm, "function", "应监听 alarm");
  assert.ok(mock.notifications.length >= 1, "加载时或刷新时应发系统通知");
  assert.ok(mock.notifications.every((n) => /提醒|逾期/.test(n.title)), mock.notifications.map((n) => n.title).join(","));
});

test("同一批提醒不重复通知；应用页面开着时完全不通知", async (t) => {
  const task = await makeDueTask("重复通知验证");
  t.after(() => dropTask(task.id));
  const storage = { baseUrl };
  const mock = mockChrome(storage);
  const bg = await loadBackground(mock.chrome, fetch);
  assert.equal(bg.startupResult.notified, 1, "显式等待启动通知成功");
  const second = await bg.refreshBadge();
  assert.equal(second.notified, 0, "已通知过的不再重复");
  const firstCount = mock.notifications.length;
  await bg.refreshBadge();
  assert.equal(mock.notifications.length, firstCount, "第三次仍不该新增通知");

  const withTab = mockChrome({ baseUrl }, { tabUrls: [`${baseUrl}/?view=notes`] });
  const bg2 = await loadBackground(withTab.chrome, fetch);
  const result = bg2.startupResult;
  assert.equal(result.notified, 0, "页面开着时由页面自己提醒");
  assert.equal(withTab.notifications.length, 0);
  assert.equal(withTab.badges.at(-1), String(result.count), "角标仍然更新");
  withTab.tabUrls.length = 0;
  assert.equal((await bg2.refreshBadge()).notified, 1, "关掉页面后仍可补发");
  assert.equal(withTab.notifications.length, 1);
  assert.equal((await bg2.refreshBadge()).notified, 0);
});

test("超过三条的提醒分轮发送，重启仍不重复已成功的通知", async (t) => {
  const tasks = [];
  t.after(async () => { for (const task of tasks) await dropTask(task.id); });
  for (let i = 0; i < 5; i++) tasks.push(await makeDueTask(`分批提醒 ${i}`));
  const storage = { baseUrl };
  const mock = mockChrome(storage);
  const bg = await loadBackground(mock.chrome, fetch);
  assert.equal(bg.startupResult.notified, 3, "notified 必须是成功创建数而非 fresh 总数");
  assert.equal(mock.notifications.length, 3);

  const restarted = mockChrome(storage);
  const bg2 = await loadBackground(restarted.chrome, fetch);
  assert.equal(bg2.startupResult.notified, 2, "未发送的两条跨重启保留到下一轮");
  assert.equal(new Set([...mock.notifications, ...restarted.notifications].map((n) => n.id)).size, 5);
  assert.equal((await bg2.refreshBadge()).notified, 0);
});

test("通知 create 失败不记为已发送，不阻止其他提醒，下轮可重试", async (t) => {
  const tasks = [];
  t.after(async () => { for (const task of tasks) await dropTask(task.id); });
  for (let i = 0; i < 4; i++) tasks.push(await makeDueTask(`失败重试 ${i}`));
  let fail = true;
  const mock = mockChrome({ baseUrl }, {
    createNotification: async (id) => {
      if (fail && id === `reminder-${tasks[0].id}`) throw new Error("Chrome 拒绝创建通知");
    },
  });
  const bg = await loadBackground(mock.chrome, fetch);
  assert.equal(bg.startupResult.notified, 2);
  assert.equal(mock.notificationAttempts.length, 3, "每轮最多尝试三条");
  assert.equal(mock.notifications.length, 2);
  fail = false;
  assert.equal((await bg.refreshBadge()).notified, 2, "失败条目和超限条目都要补发");
  assert.equal(new Set(mock.notifications.map((n) => n.id)).size, 4);
  assert.equal((await bg.refreshBadge()).notified, 0);
});

test("必须等待 create 成功才能计数或持久化已发送状态", async (t) => {
  const gate = deferred();
  const entered = deferred();
  const storage = { baseUrl };
  const mock = mockChrome(storage, { createNotification: () => { entered.resolve(); return gate.promise; } });
  const bg = await loadBackground(mock.chrome, fetch);
  const before = JSON.stringify(storage);
  const task = await makeDueTask("等待通知创建");
  t.after(() => dropTask(task.id));
  let settled = false;
  let overlapping;
  const pending = bg.refreshBadge().then((result) => { settled = true; return result; });
  try {
    await entered.promise;
    overlapping = bg.refreshBadge();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "Chrome 尚未完成 create，刷新不能提前成功");
    assert.equal(JSON.stringify(storage), before, "未完成通知不能写 sent");
    assert.equal(mock.notifications.length, 0);
    assert.equal(mock.notificationAttempts.length, 1, "锁必须覆盖通知创建阶段");
  } finally {
    gate.resolve();
    await Promise.all([pending, overlapping]);
  }
  assert.equal((await pending).notified, 1);
  assert.equal(mock.notificationAttempts.length, 1);
  assert.equal((await bg.refreshBadge()).notified, 0);
});

test("重叠刷新只允许一个执行流程且不会重复创建通知", async (t) => {
  const gate = deferred();
  const entered = deferred();
  let hold = false;
  let active = 0;
  let peak = 0;
  const mock = mockChrome({ baseUrl });
  const bg = await loadBackground(mock.chrome, async (url) => {
    active++;
    peak = Math.max(peak, active);
    try {
      if (hold) { entered.resolve(); await gate.promise; }
      return await fetch(url);
    } finally {
      active--;
    }
  });
  const task = await makeDueTask("重叠刷新任务");
  t.after(() => dropTask(task.id));
  hold = true;
  const first = bg.refreshBadge();
  await entered.promise;
  const pending = [first, ...Array.from({ length: 7 }, () => bg.refreshBadge())];
  gate.resolve();
  await Promise.all(pending);
  assert.equal(peak, 1, "服务请求也必须单飞或串行");
  assert.equal(mock.notificationAttempts.length, 1);
  assert.equal(mock.notifications.length, 1);
  assert.equal((await bg.refreshBadge()).notified, 0);
});

test("刷新异常后释放单飞状态，下一次仍能执行", async () => {
  const mock = mockChrome({ baseUrl });
  const bg = await loadBackground(mock.chrome, fetch);
  const get = mock.chrome.storage.local.get;
  mock.chrome.storage.local.get = async () => { throw new Error("storage 暂时不可用"); };
  await assert.rejects(bg.refreshBadge(), /storage 暂时不可用/);
  mock.chrome.storage.local.get = get;
  assert.equal((await bg.refreshBadge()).online, true);
});

test("应用识别必须匹配完整 origin 与入口路径，不把同前缀网址当应用", async (t) => {
  const task = await makeDueTask("应用网址识别");
  t.after(() => dropTask(task.id));
  const appBase = `${baseUrl}/app`;
  const cases = [
    [baseUrl, `${baseUrl}/?view=tasks#today`, true],
    [baseUrl, baseUrl, true],
    [baseUrl, `${baseUrl}/other`, false],
    [baseUrl, `${baseUrl}@example.com/`, false],
    [baseUrl, baseUrl.replace("127.0.0.1", "127.0.0.1.example.com") + "/", false],
    [baseUrl, baseUrl.replace("http:", "https:") + "/", false],
    [baseUrl, `http://127.0.0.1:${server.address().port + 1}/`, false],
    [appBase, `${appBase}/?view=notes`, true],
    [appBase, `${appBase}#tasks`, true],
    [appBase, `${appBase}lication/`, false],
    [appBase, `${appBase}/other`, false],
    [appBase, `${baseUrl}/`, false],
    [baseUrl, "not a URL", false],
  ];
  for (const [configured, url, isApp] of cases) {
    await t.test(url, async () => {
      const mock = mockChrome({ baseUrl: configured }, { tabUrls: ["invalid URL", url] });
      // 子路径服务用同一个临时 HTTP 服务应答，绝不访问测试之外的主机。
      const bg = await loadBackground(mock.chrome, () => fetch(`${baseUrl}/api/reminders`));
      assert.equal(bg.startupResult.notified, isApp ? 0 : 1);
      assert.equal(mock.notifications.length, isApp ? 0 : 1);
    });
  }
});

test("发送状态按服务和提醒版本隔离，改日期、时间或触发时间后可再提醒", async (t) => {
  const task = await makeDueTask("提醒版本验证");
  t.after(() => dropTask(task.id));
  // 旧版只存 ID，不能当作新格式的成功发送凭证。
  const storage = { baseUrl, seenReminderIds: [task.id] };
  const mock = mockChrome(storage);
  const bg = await loadBackground(mock.chrome, () => fetch(`${baseUrl}/api/reminders`));
  assert.equal(bg.startupResult.notified, 1);
  storage.baseUrl = `${baseUrl}/second-service`;
  assert.equal((await bg.refreshBadge()).notified, 1, "另一服务相同 ID 仍应通知");
  storage.baseUrl = baseUrl;
  assert.equal((await bg.refreshBadge()).notified, 0, "切回服务保留其已发送记录");

  for (const change of [{ due: localDate(-1) }, { dueTime: "00:02" }, { remindMinutes: 30 }]) {
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(change),
    });
    assert.equal(res.ok, true);
    assert.equal((await bg.refreshBadge()).notified, 1, `改期后必须再提醒：${JSON.stringify(change)}`);
    assert.equal((await bg.refreshBadge()).notified, 0);
  }
  const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "只改标题" }),
  });
  assert.equal(res.ok, true);
  assert.equal((await bg.refreshBadge()).notified, 0, "非提醒版本字段变化不应重复通知");
});

test("reminder 前缀通知打开任务页，其他通知仍打开笔记页并清除", async () => {
  const mock = mockChrome({ baseUrl });
  await loadBackground(mock.chrome, fetch);
  for (const [id, view] of [["reminder-task-1", "tasks"], ["clip-1", "notes"], ["other-reminder-1", "notes"]]) {
    await mock.handlers.notificationClicked(id);
    assert.deepEqual(mock.tabs.at(-1), { url: `${baseUrl}/?view=${view}` });
    assert.deepEqual(mock.notifications.at(-1), { id, cleared: true });
  }
});

test("服务不可达时角标变 ! 且不影响剪藏提示", async () => {
  const mock = mockChrome({ baseUrl: "http://127.0.0.1:1" });
  const bg = await loadBackground(mock.chrome, fetch);
  const result = await bg.refreshBadge();
  assert.deepEqual(result, { online: false, count: 0 });
  assert.equal(mock.badges.at(-1), "!");
});

test("点击剪藏成功的通知会打开笔记页", async () => {
  const mock = mockChrome({ baseUrl });
  const bg = await loadBackground(mock.chrome, fetch);
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
  const bg = await loadBackground(chrome, fetch);
  await bg.handleMenu("clip-page", { pageTitle: "某页", pageUrl: "https://example.com" }, {});
  assert.match(notifications.at(-1).title, /剪藏失败/);
  assert.match(notifications.at(-1).message, /node server\.js/);

  await bg.handleMenu("open-app", {}, {});
  assert.deepEqual(tabs, [{ url: "http://127.0.0.1:1/?view=notes" }], "open-app 只开页面不请求");
});

test("地址与笔记名可从设置弹窗改写并规范化", async () => {
  const storage = {};
  const { chrome } = mockChrome(storage);
  // 检查默认配置时也只能访问临时服务，不能碰用户可能正在运行的 8787 服务。
  const bg = await loadBackground(chrome, () => fetch(`${baseUrl}/api/reminders`));
  assert.deepEqual(await bg.getSettings(), { baseUrl: "http://127.0.0.1:8787", note: "网页剪藏" }, "默认值");

  await chrome.storage.local.set({ baseUrl: `${baseUrl}/`, note: "  收藏  " });
  const overridden = await bg.getSettings();
  assert.equal(overridden.baseUrl, baseUrl, "结尾斜杠被去掉");
  assert.equal(overridden.note, "收藏", "首尾空格被去掉");

  const second = mockChrome({ baseUrl, note: "收藏" });
  const bg2 = await loadBackground(second.chrome, fetch);
  assert.deepEqual(await bg2.getSettings(), { baseUrl, note: "收藏" });
  await bg2.handleMenu("clip-page", { pageTitle: "另一页", pageUrl: "https://example.com/d" }, {});
  assert.equal(second.notifications.at(-1)?.title, "已剪藏");
  const list = await getJson("/api/notes");
  assert.ok(list.notes.some((n) => n.title === "收藏"), "写入到自定义笔记");
});
