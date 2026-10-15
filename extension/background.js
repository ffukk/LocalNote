/**
 * 本地任务剪藏（MV3 后台脚本）
 * 右键采集页面内容 → POST 到本机服务的 /api/notes/clips → 追加进指定笔记。
 * 扩展自己不写磁盘，所有落盘由本地服务完成，因此服务必须在运行。
 */

const FALLBACK_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_NOTE = "网页剪藏";

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

function notify(id, title, message) {
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon-192.png",
    title,
    message,
    priority: 0,
  });
}

async function handleMenu(menuItemId, info, tab) {
  const { baseUrl, note } = await getSettings();
  if (menuItemId === "open-app") {
    chrome.tabs.create({ url: `${baseUrl}/?view=notes` });
    return;
  }
  const payload = buildPayload(menuItemId, info, tab);
  if (menuItemId === "clip-selection" && !payload.text) {
    notify(`clip-${Date.now()}`, "没有可剪藏的文字", "请先选中文本，再点右键菜单");
    return;
  }
  try {
    const data = await postClip(baseUrl, payload, note);
    notify(`clip-${Date.now()}`, "已剪藏", `${data.note.title}（${data.created ? "新建笔记" : "追加一条"}）`);
  } catch (error) {
    notify(`clip-${Date.now()}`, "剪藏失败", `${error.message}；确认本机服务在运行（node server.js）`);
  }
}

function registerMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const item of MENUS) chrome.contextMenus.create(item);
  });
}

chrome.runtime.onInstalled.addListener(registerMenus);
chrome.runtime.onStartup.addListener(registerMenus);
chrome.contextMenus.onClicked.addListener((info, tab) => handleMenu(info.menuItemId, info, tab));
chrome.notifications.onClicked.addListener(async (id) => {
  const { baseUrl } = await getSettings();
  chrome.tabs.create({ url: `${baseUrl}/?view=notes` });
  chrome.notifications.clear(id);
});

registerMenus();
