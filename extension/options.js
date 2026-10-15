const FALLBACK_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_NOTE = "网页剪藏";

const $ = (id) => document.getElementById(id);

async function load() {
  const stored = await chrome.storage.local.get(["baseUrl", "note"]);
  $("baseUrl").value = stored.baseUrl || FALLBACK_BASE_URL;
  $("note").value = stored.note || DEFAULT_NOTE;
  syncOpenLink();
}

function normalizedBase() {
  return String($("baseUrl").value || FALLBACK_BASE_URL).trim().replace(/\/+$/, "") || FALLBACK_BASE_URL;
}

function syncOpenLink() {
  $("open").href = `${normalizedBase()}/?view=notes`;
}

function say(message, ok = true) {
  const node = $("status");
  node.textContent = message;
  node.className = `status ${ok ? "ok" : "err"}`;
}

async function save() {
  const baseUrl = normalizedBase();
  const note = String($("note").value || "").trim() || DEFAULT_NOTE;
  await chrome.storage.local.set({ baseUrl, note });
  $("baseUrl").value = baseUrl;
  $("note").value = note;
  syncOpenLink();
  return { baseUrl, note };
}

async function testConnection() {
  const { baseUrl, note } = await save();
  say("正在连接…");
  try {
    const res = await fetch(`${baseUrl}/api/notes?q=&tag=`);
    if (!res.ok) throw new Error(`服务返回 ${res.status}`);
    const data = await res.json();
    const hit = data.notes.find((n) => n.title === note);
    say(`连接成功：${data.total} 条笔记${hit ? `，「${note}」已有 ${hit.words} 字` : `，「${note}」还没创建，第一次剪藏时会自动建`}`, true);
  } catch (error) {
    say(`连不上：${error.message}。确认本机服务已启动（node server.js），且地址填写正确。`, false);
  }
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await save();
  say("已保存", true);
});
$("test").addEventListener("click", testConnection);
$("baseUrl").addEventListener("input", syncOpenLink);

load();
