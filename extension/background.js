/**
 * 本地任务剪藏（MV3 后台脚本）
 * 右键采集页面内容 → POST 到本机服务的 /api/notes/clips → 追加进指定笔记。
 * 扩展自己不写磁盘，所有落盘由本地服务完成，因此服务必须在运行。
 */

const FALLBACK_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_NOTE = "网页剪藏";
const ALARM_NAME = "local-task-remind";
const REFRESH_MINUTES = 5;

const MENUS = [
  { id: "clip-selection", title: "剪藏选中文字到笔记", contexts: ["selection"] },
  { id: "clip-page", title: "剪藏本页链接到笔记", contexts: ["page", "link"] },
  { id: "clip-image", title: "剪藏图片到笔记", contexts: ["image"] },
  { id: "open-app", title: "打开本地任务与笔记", contexts: ["action"] },
];

async function getSettings() {
  const stored = await chrome.storage.local.get(["baseUrl", "note"]);
  const baseUrl = String(stored.baseUrl || FALLBACK_BASE_URL).trim().replace(/\/+$/, "") || FALLBACK_BASE_URL;
  const note = String(stored.note || "").trim() || DEFAULT_NOTE;
  return { baseUrl, note };
}

/** 把右键信息整理成后端需要的载荷；不同菜单项采集不同字段。 */
function buildPayload(menuItemId, info = {}, tab = {}) {
  const url = info.linkUrl || info.pageUrl || tab.url || "";
  const title = info.pageTitle || tab.title || url;
  if (menuItemId === "clip-page") return { title, url, text: "" };
  if (menuItemId === "clip-image") return { title, url, image: info.srcUrl || "", text: "" };
  return { title, url, text: info.selectionText || "" };
}

async function postClip(baseUrl, payload, note) {
  const res = await fetch(`${baseUrl}/api/notes/clips`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, note }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `服务返回 ${res.status}`);
  return data;
}

async function notify(id, title, message) {
  try {
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: "icons/icon-192.png",
      title,
      message,
      priority: 0,
    });
    return true;
  } catch {
    // 通知失败不等于剪藏失败；提醒条目留待下一轮重试。
    return false;
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`服务返回 ${res.status}`);
  return res.json();
}

/** 应用页面是否开着：开着时由页面自己提醒，避免同一件事弹两次。 */
async function appTabOpen(baseUrl) {
  try {
    const app = new URL(baseUrl);
    const appPath = app.pathname.replace(/\/+$/, "");
    const tabs = await chrome.tabs.query({});
    return tabs.some((tab) => {
      try {
        const url = new URL(tab.url);
        return url.origin === app.origin && url.pathname.replace(/\/+$/, "") === appPath;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

// 只纳入提醒计划字段；标题或 overdue 随时间变化不应导致重复通知。
function reminderKey(item) {
  return JSON.stringify([item.id, item.due, item.dueTime, item.dueAt, item.triggerAt, item.remindMinutes]);
}

let badgeRefresh = null;

/** 启动、alarm 和手动刷新共享同一轮，直到通知与持久化全部完成。 */
function refreshBadge() {
  if (!badgeRefresh) {
    badgeRefresh = refreshBadgeOnce().finally(() => { badgeRefresh = null; });
  }
  return badgeRefresh;
}

/** 定时刷新角标（今日到期/逾期数量），并对新出现的提醒发系统通知。 */
async function refreshBadgeOnce() {
  const { baseUrl } = await getSettings();
  let reminders;
  try {
    const data = await fetchJson(`${baseUrl}/api/reminders`);
    reminders = data.reminders ?? [];
  } catch {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#a4262b" });
    return { online: false, count: 0 };
  }
  await chrome.action.setBadgeText({ text: reminders.length ? (reminders.length > 99 ? "99+" : String(reminders.length)) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#e08600" });

  // 旧 seenReminderIds 含未实际发送的条目，不能迁移为成功记录。
  const stored = await chrome.storage.local.get(["sentReminderKeysByBaseUrl"]);
  const byBase = stored.sentReminderKeysByBaseUrl || {};
  const current = new Map(reminders.map((item) => [reminderKey(item), item]));
  const previous = Array.isArray(byBase[baseUrl]) ? byBase[baseUrl] : [];
  const sent = new Set(previous.filter((key) => current.has(key)));
  const saveSent = () => chrome.storage.local.set({
    sentReminderKeysByBaseUrl: { ...byBase, [baseUrl]: [...sent] },
  });
  const fresh = [...current].filter(([key]) => !sent.has(key));
  let notified = 0;
  if (fresh.length && !(await appTabOpen(baseUrl))) {
    for (const [key, item] of fresh.slice(0, 3)) {
      const created = await notify(`reminder-${item.id}`, item.overdue ? "任务已逾期" : "任务到期提醒", `${item.title} · ${item.dueTime ? `${item.due} ${item.dueTime}` : item.due}`);
      if (created) {
        sent.add(key);
        notified++;
        // 每成功一条立即保存，后续 create 失败或挂起不会丢掉前面的成功记录。
        await saveSent();
      }
    }
  }
  if (!notified) await saveSent(); // 清理本服务失效版本，不动其他服务的记录。
  return { online: true, count: reminders.length, notified };
}

function scheduleAlarms() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: REFRESH_MINUTES });
  refreshBadge().catch(() => {});
}

async function handleMenu(menuItemId, info, tab) {
  const { baseUrl, note } = await getSettings();
  if (menuItemId === "open-app") {
    chrome.tabs.create({ url: `${baseUrl}/?view=notes` });
    return;
  }
  const payload = buildPayload(menuItemId, info, tab);
  if (menuItemId === "clip-selection" && !payload.text) {
    await notify(`clip-${Date.now()}`, "没有可剪藏的文字", "请先选中文本，再点右键菜单");
    return;
  }
  try {
    const data = await postClip(baseUrl, payload, note);
    await notify(`clip-${Date.now()}`, "已剪藏", `${data.note.title}（${data.created ? "新建笔记" : "追加一条"}）`);
  } catch (error) {
    await notify(`clip-${Date.now()}`, "剪藏失败", `${error.message}；确认本机服务在运行（node server.js）`);
  }
}

function registerMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const item of MENUS) chrome.contextMenus.create(item);
  });
}

chrome.runtime.onInstalled.addListener(() => {
  registerMenus();
  scheduleAlarms();
});
chrome.runtime.onStartup.addListener(() => {
  registerMenus();
  scheduleAlarms();
});
chrome.contextMenus.onClicked.addListener((info, tab) => handleMenu(info.menuItemId, info, tab));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) refreshBadge().catch(() => {});
});
chrome.notifications.onClicked.addListener(async (id) => {
  const { baseUrl } = await getSettings();
  const view = id.startsWith("reminder-") ? "tasks" : "notes";
  chrome.tabs.create({ url: `${baseUrl}/?view=${view}` });
  chrome.notifications.clear(id);
});

registerMenus();
scheduleAlarms();
