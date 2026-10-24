import { renderMarkdown } from "./markdown.js";

const $ = (sel, node = document) => node.querySelector(sel);
const $$ = (sel, node = document) => [...node.querySelectorAll(sel)];

/* ---------------- 基础工具 ---------------- */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "value") node.value = value;
    else if (key === "checked") node.checked = Boolean(value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { "content-type": "application/json" } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(data?.error ?? `${res.status} ${res.statusText}`);
    error.status = res.status;
    error.code = data?.code;
    throw error;
  }
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast${isError ? " err" : ""}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), isError ? 4200 : 2600);
}

const DAY = 86_400_000;
function toDateISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function today() {
  return toDateISO(new Date());
}
function addDays(dateISO, n) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const date = new Date(y, m - 1, d + n);
  return toDateISO(date);
}
const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"];
function weekdayCN(dateISO) {
  const [y, m, d] = dateISO.split("-").map(Number);
  return WEEKDAY_CN[new Date(y, m - 1, d).getDay()];
}
function dueStamp(task, settings) {
  if (!task.due) return null;
  const [y, m, d] = task.due.split("-").map(Number);
  const [hh, mi] = (task.dueTime || settings?.dueEodTime || "23:59").split(":").map(Number);
  return new Date(y, m - 1, d, hh, mi).getTime();
}
function isOverdue(task) {
  if (!task.due || task.status === "done" || task.status === "trashed") return false;
  return dueStamp(task, state.data?.settings) < Date.now();
}
function relDue(task) {
  if (!task.due) return null;
  const delta = Math.round((new Date(`${task.due}T00:00`).getTime() - new Date(`${today()}T00:00`).getTime()) / DAY);
  const time = task.dueTime ? ` ${task.dueTime}` : "";
  if (delta === 0) return { text: `今天${time}`, cls: "soon" };
  if (delta === 1) return { text: `明天${time}`, cls: "" };
  if (delta === -1) return { text: `昨天${time}`, cls: "late" };
  if (delta < -1) return { text: `逾期 ${-delta} 天`, cls: "late" };
  if (delta <= 7) return { text: `${task.due.slice(5).replace("-", "/")} 周${weekdayCN(task.due)}${time}`, cls: "" };
  return { text: `${task.due.slice(5).replace("-", "/")}${time}`, cls: "" };
}
const PRIORITY_NAME = { P1: "P1 紧急", P2: "P2 重要", P3: "P3 一般", P4: "P4 稍后" };

/* ---------------- 状态 ---------------- */
const state = {
  data: null,
  tab: "tasks",
  view: "today",
  projectId: "",
  tag: "",
  priority: "",
  search: "",
  sort: "smart",
  selected: null,
  stats: null,
  statsDays: 14,
  review: null,
  reviewPreset: "week",
  reviewStart: "",
  reviewEnd: "",
  notes: { list: null, q: "", tag: "", pinned: "", currentId: null, current: null, title: "", tagsText: "", body: "", dirty: false, mode: "split", showTrash: false, trash: [], lastSave: "manual", editVersion: 0, saving: false, saveError: "", conflict: false, draftError: "", restoredDraft: false },
  reminders: [],
};

const RECENT_OPENED_KEY = "localnote:recent:v1";
const searchPanel = { open: false, seq: 0, query: "", results: { tasks: [], notes: [], recent: [] }, items: [], active: 0, loading: false, opening: false, error: "", storageWarning: "", tasksRequest: null };
let recentMemory = [];
let recentStorageFailed = false;

function readRecentOpened() {
  if (recentStorageFailed) return recentMemory;
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_OPENED_KEY) || "[]");
    if (!Array.isArray(raw)) throw new Error("记录格式错误");
    const seen = new Set();
    recentMemory = raw.filter((item) => {
      if (!item || !["task", "note"].includes(item.kind) || typeof item.id !== "string" || !item.id.trim() || item.id.length > 160) return false;
      const key = `${item.kind}:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 12).map(({ kind, id }) => ({ kind, id }));
  } catch {
    searchPanel.storageWarning = "最近打开无法读取，仅保留本次会话记录";
    recentStorageFailed = true;
  }
  return recentMemory;
}

function rememberOpened(kind, id) {
  recentMemory = [{ kind, id }, ...readRecentOpened().filter((item) => item.kind !== kind || item.id !== id)].slice(0, 12);
  try {
    localStorage.setItem(RECENT_OPENED_KEY, JSON.stringify(recentMemory));
    recentStorageFailed = false;
    searchPanel.storageWarning = "";
  } catch {
    recentStorageFailed = true;
    searchPanel.storageWarning = "最近打开无法保存，仅保留本次会话记录";
  }
}

function clearRecentOpened() {
  recentMemory = [];
  try {
    localStorage.removeItem(RECENT_OPENED_KEY);
    recentStorageFailed = false;
    searchPanel.storageWarning = "";
  } catch {
    recentStorageFailed = true;
    searchPanel.storageWarning = "浏览器中的记录未能清除，本次会话已隐藏";
  }
}

function searchPattern(query) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

function highlightedText(text, query) {
  text = String(text ?? "");
  query = query.trim();
  if (!query) return [text];
  const parts = [];
  let end = 0;
  for (const match of text.matchAll(searchPattern(query))) {
    parts.push(text.slice(end, match.index), el("mark", { text: match[0] }));
    end = match.index + match[0].length;
  }
  parts.push(text.slice(end));
  return parts;
}

function buildSearchResults(tasks, notes, query, recent) {
  const keyword = query.trim().toLowerCase();
  const taskItems = tasks.filter((task) => task.status !== "trashed").map((task) => {
    const text = task.notes ?? "";
    const at = keyword ? text.search(searchPattern(query.trim())) : -1;
    const start = Math.max(0, at - 40);
    return { kind: "task", id: task.id, title: task.title, tags: task.tags ?? [], status: task.status,
      text: `${start ? "…" : ""}${text.slice(start, start + 180)}${text.length > start + 180 ? "…" : ""}`,
      matches: !keyword || `${task.title} ${text} ${(task.tags ?? []).join(" ")}`.toLowerCase().includes(keyword) };
  });
  const noteItems = notes.map((note) => ({ kind: "note", id: note.id, title: note.title, text: note.hit || note.excerpt || "", tags: note.tags ?? [] }));
  const byId = new Map([...taskItems, ...noteItems].map((item) => [`${item.kind}:${item.id}`, item]));
  return { tasks: taskItems.filter((item) => item.matches), notes: noteItems,
    recent: keyword ? [] : recent.map((item) => byId.get(`${item.kind}:${item.id}`)).filter(Boolean) };
}

async function loadGlobalSearch() {
  const seq = ++searchPanel.seq;
  const query = searchPanel.query.trim();
  searchPanel.loading = true;
  searchPanel.error = "";
  renderGlobalSearch();
  searchPanel.tasksRequest ??= api("/api/state");
  const [tasks, notes] = await Promise.allSettled([searchPanel.tasksRequest, api(`/api/notes?${new URLSearchParams({ q: query })}`)]);
  if (!searchPanel.open || seq !== searchPanel.seq) return;
  const errors = [];
  if (tasks.status === "rejected") errors.push(`任务搜索失败：${tasks.reason.message}`);
  if (notes.status === "rejected") errors.push(`笔记搜索失败：${notes.reason.message}`);
  searchPanel.results = buildSearchResults(tasks.status === "fulfilled" ? tasks.value.tasks : [], notes.status === "fulfilled" ? notes.value.notes : [], query, readRecentOpened());
  searchPanel.error = errors.join("；");
  searchPanel.loading = false;
  searchPanel.active = 0;
  renderGlobalSearch();
}

function renderGlobalSearch() {
  if (!searchPanel.open) return;
  const { results, loading, query } = searchPanel;
  const groups = query.trim() ? [["任务", results.tasks], ["笔记", results.notes]] : [["最近打开", results.recent]];
  searchPanel.items = loading ? [] : groups.flatMap(([, items]) => items.slice(0, 20));
  const count = groups.reduce((total, [, items]) => total + items.length, 0);
  $("#global-search-status").textContent = loading ? "正在搜索…" : query.trim() ? `找到 ${count} 项 · 不受当前视图筛选限制` : `最近打开 ${count} 项 · 仅保存在此浏览器`;
  $("#global-search-clear-recent").hidden = Boolean(query.trim());
  $("#global-search-error").textContent = [searchPanel.error, searchPanel.storageWarning].filter(Boolean).join("；");
  $("#global-search-retry").hidden = !searchPanel.error || loading;
  const list = $("#global-search-results");
  list.setAttribute("aria-busy", String(loading));
  let index = 0;
  list.replaceChildren(...(loading ? [] : groups.flatMap(([name, items]) => [
    el("div", { class: "search-group", role: "presentation", text: `${name} · ${items.length}${items.length > 20 ? "（显示前 20 项，请缩小搜索范围）" : ""}` }),
    ...items.slice(0, 20).map((item) => {
      const current = index++;
      return el("button", { id: `search-result-${current}`, class: "search-result", role: "option", tabindex: "-1", "aria-selected": String(current === searchPanel.active), onclick: () => openSearchResult(item) }, [
        el("div", { class: "search-result-title" }, [el("strong", {}, highlightedText(item.title, query)), el("span", { class: "pill", text: item.kind === "note" ? "笔记" : `任务 · ${{ todo: "待办", doing: "进行中", done: "已完成" }[item.status] ?? "待办"}` })]),
        item.text ? el("div", { class: "search-result-text" }, highlightedText(item.text, query)) : null,
        item.tags.length ? el("div", { class: "search-result-tags" }, item.tags.map((tag) => el("span", { class: "pill" }, highlightedText(`#${tag}`, query)))) : null,
      ]);
    }),
  ])));
  if (!loading && !searchPanel.items.length) list.appendChild(el("div", { class: "empty", text: searchPanel.error ? "部分结果暂不可用，请重试" : query.trim() ? "没有匹配结果，试试更短的关键词" : "还没有最近打开记录，输入关键词开始搜索" }));
  updateSearchActive();
}

function updateSearchActive() {
  const input = $("#global-search-input");
  const buttons = $$(".search-result", $("#global-search-results"));
  buttons.forEach((button, index) => button.setAttribute("aria-selected", String(index === searchPanel.active)));
  const active = buttons[searchPanel.active];
  if (active) input.setAttribute("aria-activedescendant", active.id);
  else input.removeAttribute("aria-activedescendant");
}

function scheduleGlobalSearch(immediate = false) {
  clearTimeout(searchPanel.timer);
  searchPanel.seq++;
  searchPanel.query = $("#global-search-input").value.slice(0, 80);
  searchPanel.loading = true;
  searchPanel.error = "";
  renderGlobalSearch();
  if (immediate) void loadGlobalSearch();
  else searchPanel.timer = setTimeout(loadGlobalSearch, 200);
}

function showGlobalSearch() {
  if (!state.data) return;
  if (!searchPanel.open) {
    searchPanel.returnFocus = document.activeElement;
    searchPanel.open = true;
    searchPanel.tasksRequest = null;
    searchPanel.query = "";
    $("#global-search-input").value = "";
    $("#global-search-dialog").showModal();
    void loadGlobalSearch();
  }
  $("#global-search-input").focus();
  $("#global-search-input").select();
}

function closeGlobalSearch() {
  searchPanel.open = false;
  searchPanel.composing = false;
  searchPanel.seq++;
  clearTimeout(searchPanel.timer);
  $("#global-search-dialog").close();
  if (searchPanel.returnFocus?.isConnected) searchPanel.returnFocus.focus();
}

async function openSearchResult(item) {
  if (!searchPanel.open || searchPanel.opening) return;
  if (taskSaving || state.selected?.id === "new" || taskDrawer?.changed() || noteNavigating || noteDeleting) {
    searchPanel.error = "请先保存或关闭当前任务，或等待笔记操作完成，再打开搜索结果";
    renderGlobalSearch();
    return;
  }
  const selected = state.selected;
  const seq = searchPanel.seq;
  const canNavigate = () => searchPanel.open && seq === searchPanel.seq && state.selected === selected && !taskSaving && !taskDrawer?.changed();
  searchPanel.opening = true;
  $("#global-search-status")?.replaceChildren("正在打开…");
  try {
    if (item.kind === "task") {
      const { task } = await api(`/api/tasks/${encodeURIComponent(item.id)}`);
      if (!canNavigate()) return;
      if (task.status === "trashed") throw new Error("任务已移入回收站，可先恢复后再打开");
      const current = state.data.tasks.find((entry) => entry.id === task.id);
      if (current) Object.assign(current, task);
      else state.data.tasks.push(task);
      state.selected = { id: task.id };
      renderDrawer();
      rememberOpened("task", task.id);
    } else {
      let loadError;
      const opened = await changeNote(async () => {
        try { return await api(`/api/notes/${encodeURIComponent(item.id)}`); }
        catch (error) { loadError = error; throw error; }
      }, { fromTask: true, canNavigate });
      if (!opened) {
        if (!searchPanel.open || seq !== searchPanel.seq) return;
        throw new Error(loadError?.status === 404 ? "笔记已删除或不存在，可到笔记回收站恢复" : loadError?.message || state.notes.saveError || "当前草稿未保存，请关闭搜索并处理草稿后再试");
      }
    }
    if (!searchPanel.open || seq !== searchPanel.seq) return;
    closeGlobalSearch();
    $(item.kind === "task" ? "#f-title" : ".note-title")?.focus();
  } catch (error) {
    if (searchPanel.open && seq === searchPanel.seq) searchPanel.error = error.message;
  } finally {
    searchPanel.opening = false;
    renderGlobalSearch();
  }
}

const VIEWS = [
  { key: "today", name: "今天" },
  { key: "upcoming", name: "未来 7 天" },
  { key: "overdue", name: "已逾期" },
  { key: "active", name: "全部待办" },
  { key: "nodue", name: "无截止日期" },
  { key: "done", name: "已完成" },
  { key: "trashed", name: "回收站" },
  { key: "all", name: "所有任务" },
];

function viewTasks(view) {
  const data = state.data;
  if (!data) return [];
  const pool = view === "trashed" ? data.trashed : data.tasks;
  const t = today();
  const week = addDays(t, 7);
  return pool.filter((task) => {
    switch (view) {
      case "today":
        return task.due === t;
      case "upcoming":
        return task.due && task.due > t && task.due <= week && task.status !== "done";
      case "overdue":
        return isOverdue(task);
      case "active":
        return task.status !== "done";
      case "nodue":
        return !task.due && task.status !== "done";
      case "done":
        return task.status === "done";
      case "trashed":
        return true;
      default:
        return task.status !== "trashed";
    }
  });
}

function filteredTasks() {
  const keyword = state.search.trim().toLowerCase();
  return viewTasks(state.view).filter((task) => {
    if (state.projectId && (task.projectId ?? "") !== state.projectId) return false;
    if (state.priority && task.priority !== state.priority) return false;
    if (state.tag && !(task.tags ?? []).includes(state.tag)) return false;
    if (keyword && !`${task.title} ${task.notes ?? ""} ${(task.tags ?? []).join(" ")}`.toLowerCase().includes(keyword)) return false;
    return true;
  });
}

function sortedCopy(tasks) {
  const rank = { P1: 0, P2: 1, P3: 2, P4: 3 };
  const due = (t) => (t.due ? new Date(`${t.due}T${t.dueTime ?? "00:00"}`).getTime() : Number.MAX_SAFE_INTEGER);
  const by =
    state.sort === "priority"
      ? (a, b) => rank[a.priority] - rank[b.priority] || due(a) - due(b)
      : state.sort === "due"
        ? (a, b) => due(a) - due(b) || rank[a.priority] - rank[b.priority]
        : state.sort === "created"
          ? (a, b) => String(b.createdAt).localeCompare(String(a.createdAt))
          : null;
  if (!by) return tasks; // 服务端已按父子分组排好
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const children = new Map();
  const tops = [];
  for (const task of tasks) {
    const parent = task.parentId ? byId.get(task.parentId) : null;
    if (!parent) {
      tops.push(task);
      continue;
    }
    const list = children.get(parent.id) ?? [];
    list.push(task);
    children.set(parent.id, list);
  }
  tops.sort(by);
  const out = [];
  const walk = (task) => {
    out.push(task);
    for (const child of (children.get(task.id) ?? []).sort(by)) walk(child);
  };
  for (const task of tops) walk(task);
  return out;
}

function childTasks(parentId) {
  if (!state.data) return [];
  return [...state.data.tasks, ...state.data.trashed].filter((t) => t.parentId === parentId);
}

const projectOf = (id) => state.data?.projects.find((p) => p.id === id) ?? null;

/* ---------------- 侧栏 ---------------- */
function renderSidebar() {
  const counts = new Map(VIEWS.map((v) => [v.key, viewTasks(v.key).filter((t) => !t.parentId).length]));
  $("#views").replaceChildren(
    ...VIEWS.map((v) =>
      el(
        "button",
        {
          class: state.tab === "tasks" && state.view === v.key ? "active" : "",
          onclick: () => {
            state.view = v.key;
            state.tab = "tasks";
            render();
          },
        },
        [el("span", { text: v.name }), el("span", { class: "count", text: counts.get(v.key) ?? 0 })]
      )
    )
  );

  const openByProject = new Map();
  for (const task of state.data.tasks) {
    if (task.status === "done") continue;
    const key = task.projectId ?? "";
    openByProject.set(key, (openByProject.get(key) ?? 0) + 1);
  }
  $("#projects").replaceChildren(
    el(
      "li",
      { class: state.projectId === "" ? "active" : "", onclick: () => { state.projectId = ""; render(); } },
      [el("span", { class: "dot", style: "background:#9aa7bd" }), el("span", { class: "name", text: "全部项目" }), el("span", { class: "num", text: openByProject.get("") ?? 0 })]
    ),
    ...state.data.projects.map((p) =>
      el(
        "li",
        { class: state.projectId === p.id ? "active" : "", onclick: () => { state.projectId = state.projectId === p.id ? "" : p.id; render(); } },
        [
          el("span", { class: "dot", style: `background:${p.color}` }),
          el("span", { class: "name", text: p.name }),
          el("span", { class: "num", text: openByProject.get(p.id) ?? 0 }),
          el("button", {
            class: "del",
            title: `删除项目「${p.name}」，其中的任务变为未归类`,
            text: "×",
            onclick: async (e) => {
              e.stopPropagation();
              if (!confirm(`删除项目「${p.name}」？该项目下的任务会变为未归类。`)) return;
              await run(() => api(`/api/projects/${p.id}`, { method: "DELETE" }));
            },
          }),
        ]
      )
    )
  );

  $("#tags").replaceChildren(
    ...state.data.tags.map((tag) =>
      el("button", {
        class: state.tag === tag ? "active" : "",
        text: tag,
        onclick: () => {
          state.tag = state.tag === tag ? "" : tag;
          state.tab = "tasks";
          render();
        },
      })
    )
  );
}

/* ---------------- 提醒条 ---------------- */
function renderReminders() {
  const box = $("#reminders");
  box.replaceChildren(
    ...state.reminders.slice(0, 5).map((r) => {
      const late = r.overdue;
      const when = r.dueTime ? `${r.due} ${r.dueTime}` : r.due;
      return el("div", { class: `reminder${late ? " late" : ""}` }, [
        el("strong", { text: late ? "⚠ 逾期提醒" : "⏰ 到期提醒" }),
        el("span", { class: "title", text: r.title, onclick: () => openTask(r.id) }),
        el("span", { class: "when", text: `到期 ${when} · ${r.priority}` }),
        el("div", { class: "acts" }, [
          el("button", { class: "ghost small", text: "稍后 1 小时", onclick: () => run(() => api(`/api/tasks/${r.id}/reminder`, { method: "POST", body: { action: "snooze", minutes: 60 } }).then((res) => { state.reminders = res.reminders; render(); })) }),
          el("button", { class: "ghost small", text: "本次不再提醒", onclick: () => run(() => api(`/api/tasks/${r.id}/reminder`, { method: "POST", body: { action: "dismiss" } }).then((res) => { state.reminders = res.reminders; render(); })) }),
        ]),
      ]);
    })
  );
}

function notify(reminders) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const seen = notify.seen ?? (notify.seen = new Set());
  for (const r of reminders.slice(0, 3)) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    new Notification(r.overdue ? `已逾期：${r.title}` : `到期提醒：${r.title}`, { body: `优先级 ${r.priority} · 到期 ${r.dueTime ? `${r.due} ${r.dueTime}` : r.due}` });
  }
}

/* ---------------- 任务行 ---------------- */
function taskRow(task) {
  const project = task.projectId ? projectOf(task.projectId) : null;
  const done = task.status === "done";
  const children = childTasks(task.id);
  const doneChildren = children.filter((c) => c.status === "done").length;
  const due = relDue(task);
  const repeat = task.repeat?.rule && task.repeat.rule !== "none" ? task.repeat : null;
  const repeatText = repeat ? ({ daily: "每天", weekly: "每周", monthly: "每月", interval: `每 ${repeat.intervalDays ?? 1} 天`, workdays: "每个工作日" })[repeat.rule] ?? "重复" : null;

  return el("div", { class: `row${done ? " done" : ""}${task.parentId ? " child" : ""}`, dataset: { id: task.id } }, [
    el("button", {
      class: `check${done ? " on" : ""}`,
      title: done ? "标记为未完成" : "标记为完成",
      text: done ? "✓" : "",
      onclick: () => toggleDone(task),
    }),
    el("span", { class: `pill ${task.priority.toLowerCase()}`, text: task.priority, title: PRIORITY_NAME[task.priority] }),
    el("span", { class: "title", text: task.title, title: task.notes || task.title, onclick: () => openTask(task.id) }),
    task.status === "doing" ? el("span", { class: "pill doing", text: "进行中" }) : null,
    project ? el("span", { class: "pill proj", style: `border-color:${project.color}55;color:${project.color}` }, [el("span", { class: "dot", style: `width:7px;height:7px;border-radius:50%;background:${project.color}` }), project.name]) : null,
    ...(task.tags ?? []).slice(0, 3).map((tag) => el("span", { class: "pill", text: `#${tag}`, onclick: () => { state.tag = tag; render(); }, style: "cursor:pointer" })),
    due ? el("span", { class: `pill due ${due.cls}${done ? " done" : ""}`, text: due.text, onclick: () => openTask(task.id) }) : null,
    repeatText ? el("span", { class: "pill repeat", text: `↻ ${repeatText}` }) : null,
    children.length ? el("span", { class: "pill sub", text: `子任务 ${doneChildren}/${children.length}` }) : null,
    el("div", { class: "acts" }, [
      task.status === "trashed"
        ? el("button", { class: "ghost small", text: "恢复", onclick: () => run(() => api(`/api/tasks/${task.id}/restore`, { method: "POST" })) })
        : el("button", { class: "ghost small", text: task.status === "doing" ? "待办" : "进行中", onclick: () => run(() => api(`/api/tasks/${task.id}`, { method: "PATCH", body: { status: task.status === "doing" ? "todo" : "doing" } })) }),
      task.status === "trashed"
        ? el("button", { class: "danger", text: "彻底删除", onclick: async () => { if (!confirm(`彻底删除「${task.title}」及其子任务？此操作不可撤销。`)) return; await run(() => api(`/api/tasks/${task.id}/purge`, { method: "POST" })); } })
        : el("button", { class: "ghost small", text: "子任务", onclick: () => openTask(task.id, { addSub: true }) }),
      task.status !== "trashed"
        ? el("button", { class: "ghost small", text: "删除", onclick: () => run(() => api(`/api/tasks/${task.id}/trash`, { method: "POST" })) })
        : null,
    ]),
  ]);
}

async function toggleDone(task) {
  await run(async () => {
    const res = await api(`/api/tasks/${task.id}/complete`, { method: "POST", body: { done: task.status !== "done" } });
    state.reminders = res.reminders ?? state.reminders;
    if (res.spawned) toast(`已完成，重复任务的下一次已生成：${res.spawned.due ?? "无截止日期"}`);
  });
}

/* ---------------- 任务视图 ---------------- */
function renderTaskView() {
  const list = sortedCopy(filteredTasks());
  const quick = el("div", { class: "quickadd" }, [
    el("input", { type: "text", id: "quick-title", placeholder: "添加任务，回车保存…", onkeydown: (e) => { if (e.key === "Enter") quickAdd(); } }),
    el("div", { class: "more" }, [
      el("input", { class: "field", type: "date", id: "quick-due", title: "截止日期" }),
      selectField("quick-priority", Object.entries(PRIORITY_NAME).map(([v, t]) => [v, t]), "P2"),
      selectField("quick-project", [["", "未归类"], ...state.data.projects.map((p) => [p.id, p.name])], state.projectId || ""),
      el("input", { class: "field", type: "text", id: "quick-tags", placeholder: "标签,逗号分隔", style: "width:130px" }),
      el("button", { class: "primary", text: "添加", onclick: quickAdd }),
    ]),
  ]);

  const chips = [
    state.projectId ? filterChip("项目", projectOf(state.projectId)?.name ?? "", () => { state.projectId = ""; render(); }) : null,
    state.tag ? filterChip("标签", `#${state.tag}`, () => { state.tag = ""; render(); }) : null,
    state.priority ? filterChip("优先级", state.priority, () => { state.priority = ""; render(); }) : null,
    state.search ? filterChip("搜索", state.search, () => { state.search = ""; $("#search").value = ""; render(); }) : null,
  ].filter(Boolean);

  const filterBar = el("div", { class: "pick" }, [
    ...chips,
    el("span", { style: "flex:1" }),
    selectField("priority-filter", [["", "全部优先级"], ["P1", "P1 紧急"], ["P2", "P2 重要"], ["P3", "P3 一般"], ["P4", "P4 稍后"]], state.priority, (v) => { state.priority = v; render(); }),
    el("span", { class: "hint", text: `${list.length} 项` }),
  ]);

  return el("div", {}, [
    quick,
    filterBar,
    list.length
      ? el("div", { class: "list" }, list.map(taskRow))
      : el("div", { class: "empty" }, [
          el("div", { text: state.view === "trashed" ? "回收站是空的" : "这个视图还没有任务" }),
          el("div", { class: "hint", text: "在上方输入框添加任务；勾选带重复规则的任务完成后会自动生成下一次。", style: "margin-top:6px" }),
        ]),
  ]);
}

function filterChip(label, value, onClear) {
  return el("button", { class: "ghost small", title: "点击清除该筛选", onclick: onClear }, [el("span", { style: "color:var(--muted)" }, `${label}: `), value, " ✕"]);
}

function selectField(id, options, value, onchange) {
  return el(
    "select",
    { class: "field", id, onchange: onchange ? (e) => onchange(e.target.value) : undefined },
    options.map(([v, t]) => el("option", { value: v, text: t, selected: String(v) === String(value) ? "selected" : null }))
  );
}

async function quickAdd() {
  const input = $("#quick-title");
  const title = input.value.trim();
  if (!title) return input.focus();
  const body = {
    title,
    priority: $("#quick-priority").value,
    projectId: $("#quick-project").value || null,
    due: $("#quick-due").value || null,
    tags: $("#quick-tags").value,
  };
  await run(async () => {
    await api("/api/tasks", { method: "POST", body });
    input.value = "";
    $("#quick-due").value = "";
    $("#quick-tags").value = "";
    toast("已添加任务");
  });
  input.focus();
}

/* ---------------- 抽屉（详情 / 编辑 / 新建） ---------------- */
let taskDrawer = null;
let taskSaving = false;

function openTask(id, opts = {}) {
  state.selected = { id, addSub: Boolean(opts.addSub) };
  render();
}
function closeTask() {
  if (taskSaving) return toast("任务正在保存，请稍候", true);
  state.selected = null;
  render();
}

function renderDrawer() {
  const drawer = $("#drawer");
  if (!state.selected) {
    taskDrawer = null;
    drawer.hidden = true;
    drawer.replaceChildren();
    return;
  }
  if (taskDrawer?.selection === state.selected && (taskSaving || taskDrawer.changed())) return;
  drawer.hidden = false;
  const all = [...state.data.tasks, ...state.data.trashed];
  const isNew = state.selected.id === "new";
  const task = isNew ? null : all.find((t) => t.id === state.selected.id);
  if (!isNew && !task) {
    drawer.replaceChildren(el("div", { class: "empty" }, "任务已不存在"));
    return;
  }
  if (task && task.status !== "trashed" && taskDrawer?.selection !== state.selected) rememberOpened("task", task.id);
  const repeat = task?.repeat ?? { rule: "none" };
  const parentId = isNew ? state.selected.parentId ?? null : task.parentId;
  const parent = parentId ? all.find((t) => t.id === parentId) : null;
  const children = isNew ? [] : childTasks(task.id);
  const sourceNoteId = isNew ? state.selected.sourceNoteId : task.sourceNoteId;

  const form = el("div", { class: "form" });

  form.appendChild(el("label", {}, ["标题", el("input", { class: "field", id: "f-title", value: task?.title ?? state.selected.prefill ?? "", placeholder: "要做什么" })]));
  if (parent) form.appendChild(el("div", { class: "hint", text: `子任务 · 父任务：${parent.title}` }));
  if (sourceNoteId) form.appendChild(isNew
    ? el("div", { class: "hint", text: `来源笔记：${state.selected.sourceNoteTitle}` })
    : el("button", { class: "ghost", text: "打开来源笔记", onclick: () => {
        if (taskSaving || JSON.stringify(collect()) !== initialForm) return toast("请先保存任务修改，再打开来源笔记", true);
        const selected = state.selected;
        openSourceNote(sourceNoteId, () => state.selected === selected && form.isConnected && JSON.stringify(collect()) === initialForm);
      } }));
  form.appendChild(el("label", {}, ["备注", el("textarea", { class: "field", id: "f-notes", text: task?.notes ?? state.selected.notesPrefill ?? "" })]));
  form.appendChild(
    el("div", { class: "grid2" }, [
      el("label", {}, ["优先级", selectField("f-priority", Object.entries(PRIORITY_NAME), task?.priority ?? "P2")]),
      el("label", {}, ["状态", selectField("f-status", [["todo", "待办"], ["doing", "进行中"], ["done", "已完成"]], task?.status ?? "todo")]),
    ])
  );
  form.appendChild(
    el("div", { class: "grid2" }, [
      el("label", {}, ["截止日期", el("input", { class: "field", type: "date", id: "f-due", value: task?.due ?? "" })]),
      el("label", {}, ["时间（可选）", el("input", { class: "field", type: "time", id: "f-time", value: task?.dueTime ?? "" })]),
    ])
  );
  const remindOptions = [
    ["", "不单独设置"],
    ["0", "到期时"],
    ["15", "提前 15 分钟"],
    ["30", "提前 30 分钟"],
    ["60", "提前 1 小时"],
    ["180", "提前 3 小时"],
    ["360", "提前 6 小时"],
    ["720", "提前 12 小时"],
    ["1440", "提前 1 天"],
    ["2880", "提前 2 天"],
    ["10080", "提前 1 周"],
  ];
  const rm = task?.remindMinutes;
  const remindValue = rm === null || rm === undefined ? "" : String(rm);
  const remindSelect = selectField("f-remind", remindOptions.some(([v]) => v === remindValue) ? remindOptions : [...remindOptions, [remindValue, `提前 ${remindValue} 分钟`]], remindValue);
  form.appendChild(
    el("div", { class: "grid2" }, [
      el("label", {}, ["提醒", remindSelect]),
      el("label", {}, ["项目", selectField("f-project", [["", "未归类"], ...state.data.projects.map((p) => [p.id, p.name])], task?.projectId ?? "")]),
    ])
  );
  form.appendChild(el("label", {}, ["标签（逗号分隔）", el("input", { class: "field", id: "f-tags", value: (task?.tags ?? []).join(", ") })]));

  const repeatSelect = selectField(
    "f-repeat",
    [["none", "不重复"], ["daily", "每天"], ["workdays", "每个工作日"], ["weekly", "每周"], ["monthly", "每月"], ["interval", "每隔 N 天"]],
    repeat.rule
  );
  const intervalInput = el("input", { class: "field", type: "number", id: "f-interval", min: "1", max: "365", value: repeat.intervalDays ?? 3, style: "width:90px" });
  const weekdayBox = el("div", { class: "weekdays", id: "f-weekdays" }, [0, 1, 2, 3, 4, 5, 6].map((d) =>
    el("button", {
      type: "button",
      class: (repeat.weekdays ?? []).includes(d) ? "on" : "",
      text: WEEKDAY_CN[d],
      dataset: { day: String(d) },
      onclick: (e) => e.currentTarget.classList.toggle("on"),
    })
  ));
  form.appendChild(
    el("label", {}, [
      "重复",
      el("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" }, [repeatSelect]),
    ])
  );
  const extraRepeat = el("div", { id: "repeat-extra", style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" });
  const syncRepeat = () => {
    extraRepeat.replaceChildren();
    if (repeatSelect.value === "weekly") extraRepeat.appendChild(weekdayBox);
    if (repeatSelect.value === "interval") extraRepeat.appendChild(el("span", { style: "display:flex;gap:6px;align-items:center" }, [intervalInput, el("span", { class: "hint", text: "天" })]));
  };
  repeatSelect.addEventListener("change", syncRepeat);
  syncRepeat();
  form.appendChild(extraRepeat);

  const collect = () => ({
    title: $("#f-title", form).value,
    notes: $("#f-notes", form).value,
    priority: $("#f-priority", form).value,
    status: $("#f-status", form).value,
    due: $("#f-due", form).value || null,
    dueTime: $("#f-time", form).value || null,
    remindMinutes: $("#f-remind", form).value === "" ? null : Number($("#f-remind", form).value),
    projectId: $("#f-project", form).value || null,
    tags: $("#f-tags", form).value,
    repeat: (() => {
      const rule = repeatSelect.value;
      const out = { rule };
      if (rule === "interval") out.intervalDays = Number(intervalInput.value) || 3;
      if (rule === "weekly") out.weekdays = $$("button.on", weekdayBox).map((b) => Number(b.dataset.day));
      return out;
    })(),
  });

  const initialForm = JSON.stringify(collect());
  const save = async () => {
    if (taskSaving) return;
    taskSaving = true;
    const body = collect();
    const controls = $$("input, textarea, select, button", form);
    controls.forEach((control) => { control.disabled = true; });
    try {
      await run(async () => {
        if (isNew) {
          if (parentId) body.parentId = parentId;
          if (sourceNoteId) body.sourceNoteId = sourceNoteId;
          const res = await api("/api/tasks", { method: "POST", body });
          state.selected = { id: res.task.id };
          state.data.tasks.push(res.task);
          taskDrawer = null;
          renderDrawer();
        } else {
          const res = await api(`/api/tasks/${task.id}`, { method: "PATCH", body });
          Object.assign(task, res.task);
          taskDrawer = null;
        }
        toast("已保存");
      });
    } finally {
      taskSaving = false;
      controls.forEach((control) => { control.disabled = false; });
      renderDrawer();
    }
  };
  const saveButton = el("button", { class: "primary", text: isNew ? "创建任务" : "保存修改", disabled: taskSaving, onclick: save });

  form.appendChild(
    el("div", { class: "foot" }, [
      saveButton,
      isNew
        ? null
        : el("button", { class: "ghost", text: "＋ 添加子任务", onclick: () => { state.selected = { id: "new", parentId: task.id }; render(); } }),
      el("span", { style: "flex:1" }),
      task && task.status !== "trashed"
        ? el("button", {
            class: "danger",
            text: "移入回收站",
            onclick: () =>
              run(async () => {
                if (children.length && !confirm(`该任务有 ${children.length} 个子任务，将一起移入回收站。`)) return;
                await api(`/api/tasks/${task.id}/trash`, { method: "POST" });
                state.selected = null;
                toast("已移入回收站");
              }),
          })
        : null,
      task?.status === "trashed"
        ? el("button", { class: "ghost", text: "恢复", onclick: () => run(() => api(`/api/tasks/${task.id}/restore`, { method: "POST" })) })
        : null,
      task?.status === "trashed"
        ? el("button", {
            class: "danger",
            text: "彻底删除",
            onclick: () =>
              run(async () => {
                if (!confirm("彻底删除后无法恢复，确定吗？")) return;
                await api(`/api/tasks/${task.id}/purge`, { method: "POST" });
                state.selected = null;
                toast("已彻底删除");
              }),
          })
        : null,
    ])
  );

  if (!isNew && children.length) {
    const doneCount = children.filter((c) => c.status === "done").length;
    const subItems = children.map((c) => {
      const due = relDue(c);
      return el("li", { class: c.status === "done" ? "done" : "" }, [
        el("button", { class: `check${c.status === "done" ? " on" : ""}`, text: c.status === "done" ? "✓" : "", title: "切换完成", onclick: () => toggleDone(c) }),
        el("span", { text: c.title, onclick: () => openTask(c.id) }),
        due ? el("span", { class: "pill", text: due.text }) : null,
      ]);
    });
    form.appendChild(el("label", {}, [`子任务（${doneCount}/${children.length}）`, el("ul", { class: "subs" }, subItems)]));
  }

  if (!isNew) {
    const fmt = (iso) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "-");
    const nextRepeat = repeat.rule !== "none" && task.due ? `完成当前任务后将生成 ${nextDuePreview(task)}` : null;
    form.appendChild(
      el("div", { class: "meta" }, [
        `创建：${fmt(task.createdAt)}`,
        `更新：${fmt(task.updatedAt)}`,
        task.completedAt ? `完成：${fmt(task.completedAt)}` : null,
        nextRepeat,
      ].filter(Boolean).map((line) => el("span", { text: line })))
    );
  }

  drawer.replaceChildren(el("h2", {}, [el("button", { class: "close", text: "×", title: "关闭 (Esc)", onclick: closeTask }), isNew ? "新建任务" : "任务详情"]), form);
  taskDrawer = { selection: state.selected, changed: () => JSON.stringify(collect()) !== initialForm };
  if (taskSaving) $$("input, textarea, select, button", form).forEach((control) => { control.disabled = true; });
  if (state.selected.addSub) {
    state.selected.addSub = false;
    const box = $("#f-title", form);
    box?.focus();
  }
}

function nextDuePreview(task) {
  const d = new Date(`${task.due ?? today()}T00:00`);
  const rule = task.repeat.rule;
  const push = (n) => { d.setDate(d.getDate() + n); return toDateISO(d); };
  if (rule === "daily") return push(1);
  if (rule === "interval") return push(Math.max(1, Number(task.repeat.intervalDays) || 1));
  if (rule === "workdays") { let n = 1; while ([0, 6].includes(new Date(`${task.due}T00:00`).getDay() + n % 7)) n += 1; return addDays(task.due, n); }
  if (rule === "monthly") { d.setMonth(d.getMonth() + 1); return toDateISO(d); }
  if (rule === "weekly") {
    const days = task.repeat.weekdays?.length ? task.repeat.weekdays : [d.getDay()];
    for (let n = 1; n <= 8; n += 1) if (days.includes(new Date(`${addDays(task.due ?? today(), n)}T00:00`).getDay())) return addDays(task.due ?? today(), n);
  }
  return "?";
}

/* ---------------- 报表视图 ---------------- */
function svgChart(series) {
  const w = 720;
  const h = 170;
  const pad = 24;
  const max = Math.max(1, ...series.map((s) => Math.max(s.created, s.completed)));
  const bw = (w - pad * 2) / series.length;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.style.width = "100%";
  svg.style.height = "170px";
  const bar = (x, y, bw2, bh, fill) => {
    const r = document.createElementNS(ns, "rect");
    r.setAttribute("x", x);
    r.setAttribute("y", y);
    r.setAttribute("width", bw2);
    r.setAttribute("height", Math.max(0, bh));
    r.setAttribute("rx", 2);
    r.setAttribute("fill", fill);
    svg.appendChild(r);
  };
  series.forEach((point, i) => {
    const x = pad + i * bw;
    const ch = ((h - pad * 1.6) * point.created) / max;
    const dh = ((h - pad * 1.6) * point.completed) / max;
    bar(x + bw * 0.15, h - pad - ch, bw * 0.3, ch, "#c7d5f5");
    bar(x + bw * 0.5, h - pad - dh, bw * 0.3, dh, "#2f6fed");
    if (i % Math.ceil(series.length / 10) === 0 || i === series.length - 1) {
      const label = document.createElementNS(ns, "text");
      label.setAttribute("x", x + bw / 2);
      label.setAttribute("y", h - 6);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("font-size", "10");
      label.setAttribute("fill", "#6b7789");
      label.textContent = point.date.slice(5);
      svg.appendChild(label);
    }
  });
  return svg;
}

async function renderStatsView() {
  const days = state.statsDays;
  const stats = await api(`/api/stats?days=${days}${state.projectId ? `&projectId=${state.projectId}` : ""}`);
  state.stats = stats;
  const s = stats.summary;
  const box = $("#content");
  box.replaceChildren(
    el("div", { class: "pick" }, [
      el("div", { class: "seg" }, [7, 14, 30, 60].map((d) => el("button", { class: d === days ? "on" : "", text: `近 ${d} 天`, onclick: () => { state.statsDays = d; render(); } }))),
      el("span", { class: "hint", text: state.projectId ? `仅统计项目：${projectOf(state.projectId)?.name}` : "统计全部项目（可在左侧选择单个项目）" }),
    ]),
    el("div", { class: "cards" }, [
      kpi("待办任务", s.open, s.dueToday ? `今日到期 ${s.dueToday}` : null),
      kpi("已逾期", s.overdue, null, s.overdue ? "warn" : ""),
      kpi("已完成", s.done, `完成率 ${s.doneRate}%`, "ok"),
      kpi("连续完成", s.streak, "天"),
      kpi("无截止日期", s.noDue),
    ]),
    el("div", { class: "panel" }, [
      el("h3", {}, [`新增 / 完成趋势`, el("span", { class: "hint", text: `近 ${days} 天` })]),
      el("div", { class: "legend" }, [el("span", {}, [el("i", { style: "background:#c7d5f5" }), "新增"]), el("span", {}, [el("i", { style: "background:#2f6fed" }), "完成"])]),
      svgChart(stats.series),
    ]),
    el("div", { class: "split" }, [
      el("div", { class: "panel" }, [
        el("h3", {}, ["按项目"]),
        stats.byProject.length
          ? el("table", { class: "data" }, [
              el("tr", {}, [el("th", { text: "项目" }), el("th", { text: "待办", class: "num" }), el("th", { text: "逾期", class: "num" }), el("th", { text: "完成" }), el("th", { text: "完成率", class: "num" })]),
              ...stats.byProject.map((p) =>
                el("tr", {}, [
                  el("td", {}, [el("span", { class: "dot", style: `display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:${p.projectId ? projectOf(p.projectId)?.color ?? "#9aa7bd" : "#9aa7bd"}` }), p.name]),
                  el("td", { class: "num", text: p.open }),
                  el("td", { class: "num", text: p.overdue }),
                  el("td", {}, [el("div", { class: "bar" }, el("i", { style: `width:${p.total ? Math.round((p.done / p.total) * 100) : 0}%` }))]),
                  el("td", { class: "num", text: `${p.total ? Math.round((p.done / p.total) * 100) : 0}%` }),
                ])
              ),
            ])
          : el("div", { class: "hint", text: "暂无数据" }),
      ]),
      el("div", { class: "panel" }, [
        el("h3", {}, ["待办优先级分布"]),
        el("table", { class: "data" }, [
          el("tr", {}, [el("th", { text: "优先级" }), el("th", { text: "待办" }), el("th", { text: "逾期" }), el("th", { text: "总量", class: "num" })]),
          ...stats.byPriority.map((p) =>
            el("tr", {}, [
              el("td", {}, el("span", { class: `pill ${p.priority.toLowerCase()}`, text: PRIORITY_NAME[p.priority] })),
              el("td", { class: "num", text: p.open }),
              el("td", { class: "num", text: p.overdue }),
              el("td", { class: "num", text: p.total }),
            ])
          ),
        ]),
        el("div", { style: "display:flex;gap:6px;flex-wrap:wrap;margin-top:10px" }, stats.topTags.map((t) => el("span", { class: "pill", text: `#${t.tag} ${t.count}${t.open ? ` (待办 ${t.open})` : ""}` }))),
      ]),
    ])
  );
}

function kpi(k, v, sub = null, cls = "") {
  return el("div", { class: `card ${cls}` }, [el("div", { class: "k", text: k }), el("div", { class: "v" }, [String(v), sub ? el("small", { text: ` ${sub}` }) : null])]);
}

/* ---------------- 回顾视图 ---------------- */
async function renderReviewView() {
  const params = new URLSearchParams({ preset: state.reviewPreset });
  if (state.reviewPreset === "custom") {
    params.set("start", state.reviewStart || today());
    params.set("end", state.reviewEnd || today());
  }
  if (state.projectId) params.set("projectId", state.projectId);
  const rv = await api(`/api/review?${params}`);
  state.review = rv;
  const c = rv.counts;

  const listBlock = (title, items, hint, actions) =>
    el("div", { class: "panel" }, [
      el("h3", {}, [title, el("span", { class: "hint", text: `${items.length}${hint ? ` · ${hint}` : ""}` })]),
      items.length
        ? el("div", { style: "display:flex;flex-direction:column;gap:4px" }, items.map((t) =>
            el("div", { class: "row", style: "border:1px solid var(--line);border-radius:8px;padding:6px 10px" }, [
              el("span", { class: `pill ${t.priority.toLowerCase()}`, text: t.priority }),
              el("span", { class: "title", text: t.title, onclick: () => openTask(t.id) }),
              el("span", { class: "pill", text: t.projectName }),
              t.due ? el("span", { class: `pill due ${t.overdue ? "late" : ""}`, text: t.due + (t.dueTime ? ` ${t.dueTime}` : "") }) : null,
              actions ? actions(t) : null,
            ])
          ))
        : el("div", { class: "hint", text: "无记录" }),
    ]);

  const reschedule = (t) =>
    el("div", { class: "acts", style: "opacity:1;display:flex;gap:4px" }, [
      el("button", { class: "ghost small", text: "改到明天", onclick: () => run(() => api(`/api/tasks/${t.id}`, { method: "PATCH", body: { due: addDays(today(), 1) } })) }),
      el("button", { class: "ghost small", text: "顺延 7 天", onclick: () => run(() => api(`/api/tasks/${t.id}`, { method: "PATCH", body: { due: addDays(t.due || today(), 7) } })) }),
    ]);

  $("#content").replaceChildren(
    el("div", { class: "pick" }, [
      el("div", { class: "seg" }, [["week", "本周"], ["lastWeek", "上周"], ["month", "本月"], ["last30", "近 30 天"], ["custom", "自定义"]].map(([key, name]) =>
        el("button", { class: state.reviewPreset === key ? "on" : "", text: name, onclick: () => { state.reviewPreset = key; if (key === "custom" && !state.reviewStart) { state.reviewStart = addDays(today(), -14); state.reviewEnd = today(); } render(); } })
      )),
      state.reviewPreset === "custom"
        ? el("div", { style: "display:flex;gap:6px;align-items:center" }, [
            el("input", { class: "field", type: "date", value: state.reviewStart, onchange: (e) => { state.reviewStart = e.target.value; render(); } }),
            el("span", { text: "至" }),
            el("input", { class: "field", type: "date", value: state.reviewEnd, onchange: (e) => { state.reviewEnd = e.target.value; render(); } }),
          ])
        : null,
      el("span", { class: "hint", text: `${rv.label}：${rv.start} ~ ${rv.end}` }),
    ]),
    el("div", { class: "cards" }, [
      kpi("区间完成", c.completed, `新增 ${c.created}`, "ok"),
      kpi("达成率", `${c.completionRate}%`, "完成 / (完成+未达标)"),
      kpi("平均完成周期", c.avgCycleDays ?? "-", c.avgCycleDays === null ? "区间内无完成记录" : "天"),
      kpi("逾期中", c.overdueNow, null, c.overdueNow ? "warn" : ""),
      kpi("最佳单日", c.bestDay ? c.bestDay.count : "-", c.bestDay ? c.bestDay.date : ""),
    ]),
    el("div", { class: "split" }, [
      listBlock("未达成 / 顺延清单", rv.carriedOver, "需要在回顾后处理", reschedule),
      listBlock("当前逾期任务", rv.overdue, "以今天为基准", reschedule),
    ]),
    listBlock("区间内完成", rv.completed, "按完成时间倒序", null),
    rv.byProject.length
      ? el("div", { class: "panel" }, [
          el("h3", {}, ["区间项目分布"]),
          el("table", { class: "data" }, [
            el("tr", {}, [el("th", { text: "项目" }), el("th", { text: "完成数", class: "num" })]),
            ...rv.byProject.map((p) => el("tr", {}, [el("td", { text: p.name }), el("td", { class: "num", text: p.completed })])),
          ]),
        ])
      : null
  );
}

/* ---------------- 设置视图 ---------------- */
async function previewBackup(date, target, button) {
  button.disabled = true;
  target.textContent = "正在校验备份…";
  try {
    const preview = await api(`/api/backups/${encodeURIComponent(date)}/preview`);
    const recover = el("button", {
      class: "primary", text: "确认生成恢复副本", onclick: async () => {
        recover.disabled = true;
        cancel.disabled = true;
        try {
          const result = await api(`/api/backups/${encodeURIComponent(date)}/recover`, {
            method: "POST", body: { fingerprint: preview.fingerprint },
          });
          target.replaceChildren(
            el("p", { text: `恢复副本已生成：${result.dir}` }),
            el("p", { text: "现有任务和笔记未修改。请先检查副本；如需替换，请停止本地服务并另存现有数据后再操作。" })
          );
        } catch (error) {
          target.textContent = `恢复失败：${error.message}。现有数据未修改，请重新预览后再试。`;
        }
      },
    });
    const cancel = el("button", { class: "ghost", text: "取消", onclick: () => target.replaceChildren() });
    target.replaceChildren(
      el("p", { text: `${preview.date} · ${preview.taskCount} 个任务 · ${preview.noteCount} 篇笔记 · ${preview.trashCount} 条回收站记录 · ${preview.files} 个文件` }),
      el("p", { text: preview.verified ? "文件完整性校验通过。将生成独立恢复副本，不覆盖现有数据。" : "这是旧版备份：文件可读取，但没有创建时的校验清单，无法证明原始完整性。仅生成副本供检查。" }),
      el("div", { class: "pick" }, [recover, cancel])
    );
  } catch (error) {
    target.textContent = `备份校验失败：${error.message}。未生成恢复副本。`;
  } finally {
    button.disabled = false;
  }
}

async function renderSettingsView() {
  const s = state.data.settings;
  const backupInfo = await api("/api/backups").catch(() => null);
  const backupResult = el("div", { id: "backup-result", class: "hint", style: "overflow-wrap:anywhere;margin-top:12px", role: "status" });
  const backupPanel = el("div", { class: "panel", style: "max-width:800px;margin-top:14px;overflow-wrap:anywhere" }, [
    el("h3", {}, ["自动备份", el("span", { class: "hint", text: backupInfo ? `保留 ${backupInfo.keepDays} 天 · ${backupInfo.dir}` : "读取失败，请刷新重试" })]),
    backupInfo && backupInfo.backups.length
      ? el("table", { class: "data" }, [
          el("tr", {}, [el("th", { text: "日期" }), el("th", { text: "文件数", class: "num" }), el("th", { text: "大小", class: "num" }), el("th", { text: "校验 / 恢复" })]),
          ...backupInfo.backups.map((b) =>
            el("tr", {}, [
              el("td", { text: b.date }),
              el("td", { class: "num", text: b.files }),
              el("td", { class: "num", text: `${Math.max(1, Math.round(b.bytes / 1024))} KB` }),
              el("td", {}, [
                el("span", { text: b.verified ? "已校验 " : "未通过完整性校验 " }),
                el("button", { class: "ghost small", text: "恢复预览", onclick: (event) => previewBackup(b.date, backupResult, event.currentTarget) }),
              ]),
            ])
          ),
        ])
      : el("div", { class: "hint", text: backupInfo ? "还没有快照。当天第一次修改任务或笔记前会自动生成一份。" : "无法读取备份列表，不代表没有备份。" }),
    el("div", { class: "hint", text: "快照保留当天首次修改前的状态，并非实时历史。恢复预览会校验文件，确认后只生成独立副本，不覆盖正在使用的数据；旧版无校验清单的备份不会自动清理。" }),
    backupResult,
  ]);
  $("#content").replaceChildren(
    el("div", { class: "panel", style: "max-width:560px" }, [
      el("h3", {}, ["提醒与周期"]),
      el("div", { class: "form" }, [
        el("div", { class: "grid2" }, [
          el("label", {}, ["一周起始", selectField("s-week", [["1", "周一"], ["0", "周日"]], String(s.weekStart))]),
          el("label", {}, ["无时间任务的视为到期时刻", el("input", { class: "field", type: "time", id: "s-eod", value: s.dueEodTime })]),
        ]),
        el("div", { class: "grid2" }, [
          el("label", {}, ["默认提前提醒（分钟）", el("input", { class: "field", type: "number", id: "s-remind", min: "0", max: "43200", value: s.defaultRemindMinutes })]),
          el("label", {}, ["提醒轮询间隔（秒）", el("input", { class: "field", type: "number", id: "s-poll", min: "10", max: "600", value: s.reminderPollSeconds ?? 60 })]),
        ]),
        el("div", { class: "foot" }, [
          el("button", {
            class: "primary",
            text: "保存设置",
            onclick: () =>
              run(async () => {
                await api("/api/settings", {
                  method: "POST",
                  body: {
                    weekStart: Number($("#s-week").value),
                    dueEodTime: $("#s-eod").value,
                    defaultRemindMinutes: Number($("#s-remind").value),
                    reminderPollSeconds: Number($("#s-poll").value),
                  },
                });
                restartPolling();
                toast("设置已保存");
              }),
          }),
          el("button", { class: "ghost", text: "新建项目", onclick: addProject }),
          el("a", { class: "ghost", href: "/api/export", text: "导出备份" }),
        ]),
        el("div", { class: "hint", text: "数据保存在本机 data/tasks.json（可用文本编辑器直接查看）。停止服务：在终端按 Ctrl+C。" }),
      ]),
    ]),
    backupPanel
  );
}

async function addProject() {
  const name = prompt("新项目名称");
  if (!name?.trim()) return;
  const color = prompt("颜色（十六进制，如 #2f6fed）", "#2f6fed")?.trim() || "#2f6fed";
  await run(() => api("/api/projects", { method: "POST", body: { name, color } }));
}

/* ---------------- 笔记模块 ---------------- */
let noteRefs = null;
let noteDraftKey = null;
const NOTE_DRAFT_PREFIX = "localnote:draft:v1:";
const noteHistory = { open: false, seq: 0, noteId: null, session: 0, versions: [], selected: null, detail: null, loading: false, restoring: false, writing: false, error: "" };

function noteHistoryCurrent(seq) {
  return noteHistory.open && noteHistory.seq === seq && noteHistory.noteId === state.notes.currentId && noteHistory.session === noteSession;
}

function renderNoteHistory() {
  if (!noteHistory.open) return;
  const h = noteHistory;
  $("#note-history-status").textContent = h.restoring ? "正在保护当前稿并恢复…" : h.loading ? "正在读取历史…" : `${h.versions.length} 个历史版本 · ${state.notes.title}`;
  $("#note-history-error").textContent = h.error;
  $("#note-history-close").disabled = h.restoring;
  $("#note-history-refresh").disabled = h.restoring || h.loading;
  $("#note-history-restore").disabled = h.restoring || h.loading || !h.detail;
  $("#note-history-list").replaceChildren(...h.versions.map((version) => el("button", {
    class: "note-history-item", "aria-pressed": String(version.revision === h.selected), disabled: h.restoring,
    onclick: () => selectNoteHistory(version.revision),
  }, [
    el("strong", { text: version.title }),
    el("div", { class: "hint", text: `留存于 ${new Date(version.savedAt).toLocaleString("zh-CN", { hour12: false })}` }),
    el("div", { class: "hint", text: `${version.words} 字 · ${version.revision.slice(0, 8)}` }),
  ])));
  const preview = $("#note-history-preview");
  preview.setAttribute("aria-busy", String(h.loading));
  if (h.detail) {
    const { version, body } = h.detail;
    preview.replaceChildren(
      el("h3", { text: version.title }),
      el("div", { class: "hint", text: `${version.pinned ? "已置顶 · " : ""}${version.tags.map((tag) => `#${tag}`).join(" ")}` }),
      el("pre", { text: body || "（空正文）" }),
    );
  } else preview.replaceChildren(el("div", { class: "hint", text: h.loading ? "正在读取…" : h.error ? "历史暂不可用，请刷新后重试" : h.versions.length ? "选择左侧版本查看原文" : "暂无历史；下次保存内容变更时会留存当前版本" }));
}

async function loadNoteHistory() {
  if (!noteHistory.open || noteHistory.restoring) return;
  const seq = ++noteHistory.seq;
  Object.assign(noteHistory, { loading: true, error: "", versions: [], selected: null, detail: null });
  renderNoteHistory();
  try {
    const data = await api(`/api/notes/${encodeURIComponent(noteHistory.noteId)}/history`);
    if (noteHistoryCurrent(seq)) noteHistory.versions = data.versions;
  } catch (error) {
    if (noteHistoryCurrent(seq)) noteHistory.error = `历史读取失败：${error.message}`;
  } finally {
    if (noteHistoryCurrent(seq)) { noteHistory.loading = false; renderNoteHistory(); }
  }
}

async function selectNoteHistory(revision) {
  if (!noteHistory.open || noteHistory.restoring) return;
  const seq = ++noteHistory.seq;
  Object.assign(noteHistory, { loading: true, error: "", selected: revision, detail: null });
  renderNoteHistory();
  try {
    const data = await api(`/api/notes/${encodeURIComponent(noteHistory.noteId)}/history/${encodeURIComponent(revision)}`);
    if (noteHistoryCurrent(seq)) noteHistory.detail = data;
  } catch (error) {
    if (noteHistoryCurrent(seq)) noteHistory.error = `版本读取失败：${error.message}`;
  } finally {
    if (noteHistoryCurrent(seq)) { noteHistory.loading = false; renderNoteHistory(); }
  }
}

function showNoteHistory() {
  if (!state.notes.currentId || noteNavigating || searchPanel.open || noteComposing) return;
  if (noteHistory.open) return;
  Object.assign(noteHistory, { open: true, noteId: state.notes.currentId, session: noteSession, returnFocus: document.activeElement });
  $("#note-history-dialog").showModal();
  void loadNoteHistory();
}

function closeNoteHistory() {
  if (noteHistory.restoring) return;
  noteHistory.open = false;
  noteHistory.seq++;
  $("#note-history-dialog").close();
  if (noteHistory.returnFocus?.isConnected) noteHistory.returnFocus.focus();
}

async function restoreNoteHistory() {
  const h = noteHistory;
  if (!h.open || h.loading || h.restoring || !h.detail) return;
  const seq = h.seq;
  if (!noteHistoryCurrent(seq)) return;
  if (noteNavigating || noteDeleting || noteComposing || taskSaving || state.selected?.id === "new" || taskDrawer?.changed()) {
    h.error = "请先保存或关闭当前任务，或等待笔记操作完成，再恢复历史";
    renderNoteHistory();
    return;
  }
  const revision = h.detail.version.revision;
  if (!confirm(`恢复「${h.detail.version.title}」的此历史版本？\n会先保存当前草稿，再恢复标题、标签、置顶与正文；恢复前的版本仍会保留。`)) return;
  h.restoring = true;
  h.error = "";
  noteNavigating = true;
  renderNoteHistory();
  try {
    if (!(await saveNote({ silent: true }))) throw new Error("当前草稿尚未保存，请关闭历史并处理草稿后再恢复");
    if (!noteHistoryCurrent(seq)) return;
    const version = state.notes.editVersion;
    h.writing = true;
    const data = await api(`/api/notes/${encodeURIComponent(h.noteId)}/history/${encodeURIComponent(revision)}/restore`, {
      method: "POST", body: { baseRevision: state.notes.current.revision },
    });
    if (!noteHistoryCurrent(seq)) return;
    if (version !== state.notes.editVersion) {
      state.notes.conflict = true;
      state.notes.saveError = "历史版本已恢复，但期间的新输入已保留为草稿；请下载草稿后重新载入";
      persistNoteDraft();
      updateNoteStatus();
      throw new Error(state.notes.saveError);
    }
    setCurrentNote(data);
    await loadNotes().catch((error) => toast(`历史版本已恢复，列表刷新失败：${error.message}`, true));
    await render();
    h.restoring = false;
    closeNoteHistory();
    $(".note-title")?.focus();
    toast("已恢复历史版本，恢复前的内容仍保留在版本历史中");
    return true;
  } catch (error) {
    if (h.open && h.seq === seq) h.error = error.message;
    if (noteHistoryCurrent(seq) && error.code === "NOTE_CONFLICT") {
      state.notes.conflict = true;
      state.notes.saveError = "磁盘版本已变化，未恢复历史；请保留草稿并重新载入后再试";
      updateNoteStatus();
    }
    return false;
  } finally {
    h.restoring = false;
    h.writing = false;
    noteNavigating = false;
    renderNoteHistory();
  }
}

function parseNoteDraft(raw) {
  const draft = JSON.parse(raw);
  if (!draft || draft.version !== 1 ||
      !["dir", "noteId", "baseRevision", "title", "tagsText", "body", "savedAt"].every((key) => typeof draft[key] === "string") ||
      !draft.dir || !draft.noteId.startsWith("n_") || !draft.baseRevision || !Number.isFinite(Date.parse(draft.savedAt))) {
    throw new Error("草稿格式无效");
  }
  return draft;
}

function persistNoteDraft() {
  const n = state.notes;
  if (!n.currentId || !n.dirty) return false;
  const previous = noteDraftKey;
  try {
    if (!n.list?.dir) throw new Error("笔记目录尚未加载");
    const key = NOTE_DRAFT_PREFIX + crypto.randomUUID();
    const draft = {
      version: 1, dir: n.list.dir, noteId: n.currentId, baseRevision: n.current.revision,
      title: n.title, tagsText: n.tagsText, body: n.body, savedAt: new Date().toISOString(),
    };
    // 快照键只写一次；先写新快照再删本页旧快照，避免多标签页互相覆盖。
    localStorage.setItem(key, JSON.stringify(draft));
    noteDraftKey = key;
    n.draftError = "";
  } catch {
    n.draftError = "浏览器草稿留存失败（存储不可用或空间不足），请立即保存或下载当前草稿";
    return false;
  }
  try {
    if (previous) localStorage.removeItem(previous);
  } catch {
    n.draftError = "最新草稿已留存，但旧副本清理失败，恢复列表中可能有重复项";
  }
  return true;
}

function clearNoteDraft() {
  try {
    if (noteDraftKey) localStorage.removeItem(noteDraftKey);
    noteDraftKey = null;
    state.notes.draftError = "";
    return true;
  } catch {
    state.notes.draftError = "浏览器草稿清理失败，旧副本仍可能出现在恢复列表中";
    return false;
  }
}

function readNoteDrafts() {
  const drafts = [];
  let error = "";
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key?.startsWith(NOTE_DRAFT_PREFIX) || key === noteDraftKey) continue;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      try {
        const draft = parseNoteDraft(raw);
        if (draft.dir === state.notes.list?.dir) drafts.push({ ...draft, key });
      } catch {
        error = "部分浏览器草稿格式异常，已保留原记录，未自动删除";
      }
    }
  } catch {
    error = "无法读取浏览器草稿，可能是存储被禁用；不能确认是否有可恢复内容";
  }
  drafts.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return { drafts, error };
}

function storedNoteDraft(key) {
  if (typeof key !== "string" || !key.startsWith(NOTE_DRAFT_PREFIX)) throw new Error("无效的草稿记录");
  const raw = localStorage.getItem(key);
  if (raw === null) throw new Error("草稿已被其他页面处理，请刷新列表");
  const draft = parseNoteDraft(raw);
  if (draft.dir !== state.notes.list?.dir) throw new Error("草稿不属于当前笔记目录");
  return draft;
}

function discardNoteDraft(key) {
  try {
    if (key === noteDraftKey) throw new Error("不能丢弃正在编辑的草稿，请先保存或重新载入");
    storedNoteDraft(key);
    localStorage.removeItem(key);
    refreshNoteDrafts();
    return true;
  } catch (error) {
    toast(`草稿未丢弃：${error.message}`, true);
    return false;
  }
}

async function recoverNoteDraft(key) {
  if (noteNavigating) return;
  noteNavigating = true;
  try {
    const draft = storedNoteDraft(key);
    if (!(await saveNote({ silent: true }))) return;
    const data = await api(`/api/notes/${encodeURIComponent(draft.noteId)}`);
    await loadNotes();
    if (!(await saveNote({ silent: true }))) return;
    if (draft.dir !== state.notes.list?.dir) throw new Error("笔记目录已变化，草稿未恢复");
    setCurrentNote(data);
    Object.assign(state.notes, {
      title: draft.title, tagsText: draft.tagsText, body: draft.body, dirty: true, editVersion: 1,
      current: { ...data.note, revision: draft.baseRevision }, restoredDraft: true,
      conflict: data.note.revision !== draft.baseRevision,
      saveError: data.note.revision !== draft.baseRevision ? "磁盘版本已变化，已恢复草稿但不会覆盖；请下载草稿后重新载入并合并" : "",
    });
    // 原快照可能属于仍在编辑的其他页面，恢复只创建副本，不接管或删除原记录。
    persistNoteDraft();
    state.notes.showTrash = false;
    await render();
  } catch (error) {
    toast(error.status === 404 ? "原笔记已不存在；草稿仍保留，可下载或先从回收站恢复笔记" : `草稿未恢复：${error.message}`, true);
  } finally {
    noteNavigating = false;
  }
}

function noteDraftStatusText() {
  if (state.notes.draftError) return state.notes.draftError;
  return state.notes.dirty && noteDraftKey ? "已留存浏览器草稿 · 仅限本机当前浏览器和地址" : "";
}

function noteDraftItems() {
  const { drafts, error } = readNoteDrafts();
  return [
    error ? el("div", { class: "hint draft-warning", role: "status", text: error }) : null,
    el("details", { open: drafts.length > 0 }, [
      el("summary", { text: `待恢复的浏览器草稿 ${drafts.length}` }),
      el("div", { class: "hint", text: "恢复副本后请检查并手动保存。原草稿可能来自其他打开的页面，因此保留原记录，确认无误后可手动丢弃；原笔记已删除时仍可下载。" }),
      ...drafts.map((draft) => el("div", { class: "note-draft-item" }, [
        el("strong", { text: draft.title || "未命名笔记" }),
        el("div", { class: "note-item-sub", text: new Date(draft.savedAt).toLocaleString("zh-CN", { hour12: false }) }),
        el("div", { class: "note-item-ex", text: draft.body.slice(0, 160) }),
        el("div", { class: "note-item-tags" }, [
          el("button", { class: "ghost small", text: "恢复到编辑器", onclick: () => recoverNoteDraft(draft.key) }),
          el("button", { class: "ghost small", text: "下载草稿", onclick: () => downloadNoteDraft(draft) }),
          el("button", { class: "ghost small", text: "丢弃草稿", onclick: (event) => {
            event.currentTarget.parentElement.replaceChildren(
              el("span", { class: "hint", text: "只丢弃这份浏览器草稿，不影响磁盘笔记。" }),
              el("button", { class: "danger", text: "确认丢弃", onclick: () => discardNoteDraft(draft.key) }),
              el("button", { class: "ghost small", text: "取消", onclick: refreshNoteDrafts })
            );
          } }),
        ]),
      ])),
    ]),
  ].filter(Boolean);
}

function refreshNoteDrafts() {
  if (noteRefs?.drafts) noteRefs.drafts.replaceChildren(...noteDraftItems());
}

function notesQuery() {
  const params = new URLSearchParams();
  if (state.notes.q) params.set("q", state.notes.q);
  if (state.notes.tag) params.set("tag", state.notes.tag);
  if (state.notes.pinned) params.set("pinned", state.notes.pinned);
  return params.toString();
}

let notesReq = 0;

async function loadNotes() {
  const seq = ++notesReq;
  const data = await api(`/api/notes?${notesQuery()}`);
  if (seq === notesReq) state.notes.list = data;
  return state.notes.list;
}

async function runNotes(action) {
  try {
    await action();
    await loadNotes();
    syncCurrentNote();
    await render();
  } catch (error) {
    toast(error.message, true);
  }
}

function syncCurrentNote() {
  const fresh = state.notes.list?.notes.find((n) => n.id === state.notes.currentId);
  // 列表可能被筛选或来自其它写入，不能替代当前正文对应的版本基线。
  if (fresh && fresh.revision === state.notes.current?.revision) state.notes.current = fresh;
}

function noteStatusText() {
  const n = state.notes;
  if (n.saveError) return `未保存 · ${n.saveError}`;
  if (n.saving) return "正在保存…继续输入的内容也会保存";
  if (n.restoredDraft) return "未保存 · 已恢复浏览器草稿，请检查后手动保存";
  if (n.dirty) return "未保存 · 2 秒后自动保存";
  return `${n.lastSave === "auto" ? "已自动保存" : "已保存"} · ${(n.current?.updatedAt ?? "").slice(0, 16).replace("T", " ")}`;
}

function updateNoteStatus() {
  if (noteRefs?.id !== state.notes.currentId) return;
  if (noteRefs.hint) noteRefs.hint.textContent = noteStatusText();
  if (noteRefs.recovery) noteRefs.recovery.hidden = !state.notes.saveError && !state.notes.draftError && !state.notes.restoredDraft;
  if (noteRefs.draftStatus) {
    noteRefs.draftStatus.textContent = noteDraftStatusText();
    noteRefs.draftStatus.classList.toggle("draft-warning", Boolean(state.notes.draftError));
  }
  if (noteRefs.file) noteRefs.file.textContent = `文件：notes/${state.notes.current.file}.md`;
}

let autoSaveTimer = null;
let saveFlight = null;
let noteSession = 0;
let noteNavigating = false;
let noteComposing = false;
let noteDeleting = false;

function markNoteDirty() {
  state.notes.editVersion += 1;
  state.notes.dirty = true;
  if (!state.notes.conflict) state.notes.saveError = "";
  persistNoteDraft();
  updateNoteStatus();
  scheduleAutoSave();
}

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  if (noteComposing || noteDeleting || noteHistory.writing || state.notes.conflict || state.notes.restoredDraft) return;
  autoSaveTimer = setTimeout(() => {
    if (state.notes.dirty && state.notes.currentId) saveNote({ silent: true });
  }, 2000);
}

function setCurrentNote(data) {
  clearTimeout(autoSaveTimer);
  noteSession += 1;
  noteDraftKey = null;
  noteComposing = false;
  Object.assign(state.notes, {
    currentId: data?.note.id ?? null, current: data?.note ?? null,
    title: data?.note.title ?? "", tagsText: (data?.note.tags ?? []).join(", "), body: data?.body ?? "",
    dirty: false, editVersion: 0, saveError: "", conflict: false, lastSave: "manual", draftError: "", restoredDraft: false,
  });
}

async function changeNote(load, { fromTask = false, canNavigate = () => true } = {}) {
  if (noteNavigating) return;
  noteNavigating = true;
  try {
    if (!(await saveNote({ silent: true }))) {
      if (fromTask) toast("当前笔记尚未保存，请先处理草稿后再跳转", true);
      return;
    }
    const version = state.notes.editVersion;
    const data = await load();
    await loadNotes();
    if (!(await saveNote({ silent: true }))) return;
    if (!canNavigate()) return toast("跳转期间任务有变化，已保留当前任务，请保存后重试", true);
    // 回跳同一笔记时，网络等待期间的新输入优先于旧响应。
    if (data?.note.id !== state.notes.currentId || version === state.notes.editVersion) setCurrentNote(data);
    state.notes.showTrash = false;
    if (fromTask) {
      state.tab = "notes";
      state.selected = null;
      Object.assign(state.notes, { q: "", tag: "", pinned: "", list: null });
    }
    await render();
    if (state.notes.currentId) rememberOpened("note", state.notes.currentId);
    return true;
  } catch (error) {
    toast(error.message, true);
  } finally {
    noteNavigating = false;
  }
}

async function openSourceNote(id, canNavigate = () => true) {
  await changeNote(async () => {
    try {
      return await api(`/api/notes/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error.status === 404) throw new Error("来源笔记已删除或不存在，可到笔记回收站恢复；任务仍保留");
      throw error;
    }
  }, { fromTask: true, canNavigate });
}

async function createTaskFromNote(text = "") {
  if (noteNavigating || !state.notes.currentId) return;
  if (taskSaving || state.selected?.id === "new" || taskDrawer?.changed()) return toast("请先保存或关闭当前任务，再生成新任务", true);
  text = text.trim();
  if (text.length > 4000) return toast("选中内容超过任务备注的 4000 字符上限，请缩小选区后再生成", true);
  noteNavigating = true;
  try {
    if (!(await saveNote({ silent: true }))) return toast("请先保存笔记或处理未保存的草稿，再生成任务", true);
    if (taskSaving || state.selected?.id === "new" || taskDrawer?.changed()) return toast("请先保存或关闭当前任务，再生成新任务", true);
    state.selected = {
      id: "new", sourceNoteId: state.notes.currentId, sourceNoteTitle: state.notes.title,
      prefill: (text.split(/\r?\n/)[0] || state.notes.title).slice(0, 200), notesPrefill: text,
    };
    renderDrawer();
    $("#f-title")?.focus();
  } finally {
    noteNavigating = false;
  }
}

async function openNote(id) {
  if (id === state.notes.currentId) return;
  await changeNote(() => api(`/api/notes/${encodeURIComponent(id)}`));
}

async function newNote() {
  await changeNote(() => api("/api/notes", { method: "POST", body: { title: "未命名笔记", body: "" } }));
  noteRefs?.title?.focus();
}

async function saveNote({ silent = false } = {}) {
  clearTimeout(autoSaveTimer);
  if (noteHistory.writing) return false;
  if (saveFlight) return saveFlight;
  if (!state.notes.currentId || !state.notes.dirty) return true;
  if (noteComposing || noteDeleting || state.notes.conflict || (silent && state.notes.restoredDraft)) return false;
  persistNoteDraft();
  const id = state.notes.currentId;
  const session = noteSession;
  state.notes.saving = true;
  state.notes.saveError = "";
  updateNoteStatus();
  saveFlight = (async () => {
    try {
      while (state.notes.currentId === id && noteSession === session && state.notes.dirty) {
        if (noteComposing) return false;
        const version = state.notes.editVersion;
        const res = await api(`/api/notes/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: { title: state.notes.title, tags: state.notes.tagsText, body: state.notes.body, baseRevision: state.notes.current.revision },
        });
        if (state.notes.currentId !== id || noteSession !== session) return true;
        state.notes.current = res.note;
        state.notes.dirty = state.notes.editVersion !== version;
        state.notes.lastSave = silent ? "auto" : "manual";
        if (state.notes.dirty) persistNoteDraft();
        else {
          state.notes.restoredDraft = false;
          clearNoteDraft();
        }
        updateNoteStatus();
      }
      refreshNoteDrafts();
      if (!silent) toast("笔记已保存");
      loadNotes().then(() => {
        if (state.tab === "notes" && noteRefs?.list) noteRefs.list.replaceChildren(...noteListItems());
      }).catch((error) => toast(`正文已保存，列表刷新失败：${error.message}`, true));
      return true;
    } catch (error) {
      if (state.notes.currentId === id && noteSession === session) {
        state.notes.saveError = error.code === "NOTE_CONFLICT"
          ? "版本冲突，草稿已保留；请下载草稿后重新载入"
          : `${error.message}；草稿已保留，可重试保存`;
        state.notes.conflict = error.code === "NOTE_CONFLICT";
      }
      toast(error.message, true);
      return false;
    } finally {
      state.notes.saving = false;
      saveFlight = null;
      updateNoteStatus();
    }
  })();
  return saveFlight;
}

function downloadNoteDraft(draft = state.notes) {
  const text = `# ${draft.title}\n\n${draft.tagsText ? `标签：${draft.tagsText}\n\n` : ""}${draft.body}`;
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = el("a", { href: url, download: "笔记草稿.md" });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function reloadNote() {
  if (noteNavigating || !confirm("重新载入会丢弃当前草稿，请先下载草稿留存。确定继续？")) return;
  noteNavigating = true;
  try {
    if (saveFlight) await saveFlight;
    const id = state.notes.currentId;
    const version = state.notes.editVersion;
    const data = await api(`/api/notes/${encodeURIComponent(id)}`);
    if (version !== state.notes.editVersion) return toast("载入期间有新输入，已保留草稿，请重试", true);
    const cleared = clearNoteDraft();
    const draftError = state.notes.draftError;
    setCurrentNote(data);
    if (!cleared) state.notes.draftError = draftError;
    await render();
  } catch (error) {
    toast(error.message, true);
  } finally {
    noteNavigating = false;
  }
}

async function toggleNotePin(note) {
  if (!(await saveNote({ silent: true }))) return;
  await runNotes(async () => {
    const res = await api(`/api/notes/${encodeURIComponent(note.id)}`, {
      method: "PATCH", body: { pinned: !note.pinned, baseRevision: state.notes.current?.revision },
    });
    if (state.notes.currentId === note.id) state.notes.current = res.note;
  });
}

async function deleteNote(note) {
  if (noteNavigating || !confirm(`删除笔记「${note.title}」？\n会先保存当前草稿，再移入回收站，7 天内可恢复。`)) return;
  noteNavigating = true;
  try {
    if (!(await saveNote({ silent: true }))) return;
    const version = state.notes.editVersion;
    noteDeleting = true;
    await api(`/api/notes/${encodeURIComponent(note.id)}`, { method: "DELETE" });
    if (state.notes.currentId === note.id) {
      if (state.notes.editVersion === version) setCurrentNote(null);
      else {
        state.notes.saveError = "笔记已移入回收站；删除期间的新输入已保留，请下载草稿";
        state.notes.conflict = true;
      }
    }
    await loadNotes();
    await render();
    toast("已移入回收站，7 天内可恢复");
  } catch (error) {
    toast(error.message, true);
  } finally {
    noteNavigating = false;
    noteDeleting = false;
    if (state.notes.dirty) scheduleAutoSave();
    updateNoteStatus();
  }
}

async function restoreTrash(item) {
  await runNotes(async () => {
    await api(`/api/notes/trash/${encodeURIComponent(item.trashFile)}/restore`, { method: "POST" });
    toast(`已恢复「${item.title}」`);
  });
}

async function purgeTrash(item) {
  if (!confirm(`彻底删除「${item.title}」？\n文件将从回收站移除，不可恢复。`)) return;
  await runNotes(async () => {
    await api(`/api/notes/trash/${encodeURIComponent(item.trashFile)}/purge`, { method: "POST" });
    toast("已彻底删除");
  });
}

async function onNoteFiles(event) {
  const files = [...(event.target.files ?? [])];
  if (!files.length) return;
  const items = await Promise.all(files.map(async (f) => ({ name: f.name, content: await f.text() })));
  await runNotes(async () => {
    const res = await api("/api/notes/import", { method: "POST", body: { files: items } });
    const skipped = res.skipped.length ? `，跳过 ${res.skipped.length} 条（${res.skipped.slice(0, 2).map((s) => s.reason).join("；")}${res.skipped.length > 2 ? "…" : ""}）` : "";
    toast(`导入完成：新增 ${res.created.length} 条${skipped}`);
  });
  event.target.value = "";
}

function noteListPane() {
  const list = state.notes.list?.notes ?? [];
  const search = el("input", {
    class: "field note-search",
    type: "search",
    placeholder: "搜索笔记标题、正文与标签",
    maxlength: 80,
    value: state.notes.q,
    oninput: (e) => {
      state.notes.q = e.target.value;
      clearTimeout(noteListPane.timer);
      noteListPane.timer = setTimeout(async () => {
        const query = state.notes.q;
        await loadNotes();
        if (query !== state.notes.q || !noteRefs?.list) return;
        noteRefs.list.replaceChildren(...noteListItems());
      }, 200);
    },
  });
  return el("div", { class: "note-side" }, [
    el("div", { class: "note-side-head" }, [
      el("button", { class: "primary", text: "＋ 新建笔记", onclick: newNote }),
      el("button", { class: "ghost small", text: "导入 .md", onclick: () => $("#note-file-input").click() }),
      el("button", {
        class: state.notes.showTrash ? "ghost small active-chip" : "ghost small",
        text: `回收站${state.notes.list?.trashCount ? ` ${state.notes.list.trashCount}` : ""}`,
        title: "删除的笔记保留 7 天",
        onclick: () => {
          state.notes.showTrash = !state.notes.showTrash;
          render();
        },
      }),
    ]),
    search,
    el("div", { id: "note-drafts", class: "note-drafts" }, noteDraftItems()),
    el("div", { class: "tag-cloud note-tags" }, [
      el("button", { class: state.notes.tag === "" ? "active" : "", text: "全部", onclick: () => runNotes(() => { state.notes.tag = ""; }) }),
      ...(state.notes.list?.tags ?? []).map((tag) =>
        el("button", { class: state.notes.tag === tag ? "active" : "", text: tag, onclick: () => runNotes(() => { state.notes.tag = state.notes.tag === tag ? "" : tag; }) })
      ),
    ]),
    el("div", { class: "note-list", id: "note-list" }, noteListItems()),
  ]);
}

function noteListItems() {
  if (state.notes.showTrash) {
    const trash = state.notes.trash ?? [];
    if (!trash.length) return [el("div", { class: "empty", text: "回收站是空的" })];
    return trash.map((item) =>
      el("div", { class: "note-item trash" }, [
        el("div", { class: "note-item-title" }, el("span", { text: item.title })),
        el("div", { class: "note-item-sub", text: `删除于 ${(item.deletedAt ?? "").slice(0, 16).replace("T", " ")} · ${item.words} 字` }),
        el("div", { class: "note-item-tags" }, [
          el("button", { class: "ghost small", text: "恢复", onclick: () => restoreTrash(item) }),
          el("button", { class: "danger", text: "彻底删除", onclick: () => purgeTrash(item) }),
        ]),
      ])
    );
  }
  const list = state.notes.list?.notes ?? [];
  if (!list.length) return [el("div", { class: "empty", text: state.notes.q ? "没有匹配的笔记" : "还没有笔记，点「新建笔记」或导入 .md 文件" })];
  return list.map((note) => {
    const selected = state.notes.currentId === note.id;
    const children = [
      el("div", { class: "note-item-title" }, [
        note.pinned ? el("span", { class: "pin", title: "已置顶", text: "📌" }) : null,
        el("span", {}, highlightedText(note.title, state.notes.q)),
      ]),
      el("div", { class: "note-item-sub", text: `${(note.updatedAt ?? "").slice(0, 16).replace("T", " ")} · ${note.words} 字` }),
      (note.hit || note.excerpt) ? el("div", { class: "note-item-ex" }, highlightedText(note.hit || note.excerpt, state.notes.q)) : null,
      note.tags.length ? el("div", { class: "note-item-tags" }, note.tags.map((t) => el("span", { class: "pill" }, highlightedText(`#${t}`, state.notes.q)))) : null,
    ].filter(Boolean);
    return el("div", { class: `note-item${selected ? " on" : ""}`, onclick: () => openNote(note.id) }, children);
  });
}

function noteSelectionText(editor, preview) {
  const selection = window.getSelection();
  if (selection && preview.contains(selection.anchorNode) && preview.contains(selection.focusNode) && !selection.isCollapsed) {
    return selection.toString();
  }
  return editor.isConnected && document.activeElement === editor ? editor.value.slice(editor.selectionStart, editor.selectionEnd) : "";
}

function noteLinkedTasks() {
  const tasks = (state.data?.tasks ?? []).filter((task) => task.sourceNoteId === state.notes.currentId && task.status !== "trashed");
  const done = tasks.filter((task) => task.status === "done").length;
  return el("div", { class: "note-linked-tasks" }, [
    el("div", { class: "hint", text: tasks.length ? `关联任务 · ${done}/${tasks.length} 已完成` : "选中文字后点「生成任务」；未选中时使用笔记标题" }),
    tasks.length ? el("div", { class: "note-linked-list" }, tasks.map((task) => el("button", {
      class: "ghost note-task-link", onclick: () => {
        if (state.selected?.id === task.id) return;
        if (taskSaving || state.selected?.id === "new" || taskDrawer?.changed()) return toast("请先保存或关闭当前任务，再打开关联任务", true);
        state.selected = { id: task.id };
        renderDrawer();
      },
    }, [
      el("span", { text: task.title }),
      el("span", { class: "pill", text: { todo: "待办", doing: "进行中", done: "已完成" }[task.status] }),
    ]))) : null,
  ]);
}

function noteEditorPane() {
  if (!state.notes.currentId) {
    return el("div", { class: "note-editor" }, el("div", { class: "empty" }, [
      el("div", { text: "选择左侧笔记，或新建一条" }),
      el("div", { class: "hint", text: "笔记以 Markdown 文件存放在 notes/ 目录，可被其它编辑器直接修改。", style: "margin-top:8px" }),
    ]));
  }
  const note = state.notes.current;
  const session = noteSession;
  const preview = el("div", { class: "md-body" });
  preview.appendChild(renderMarkdown(state.notes.body));
  const editor = el("textarea", {
    class: "note-text",
    placeholder: "用 Markdown 写点什么…支持标题、列表、待办、代码块、表格、链接",
    value: state.notes.body,
    spellcheck: "false",
    oninput: (e) => {
      if (session !== noteSession) return;
      state.notes.body = e.target.value;
      markNoteDirty();
      clearTimeout(noteEditorPane.timer);
      noteEditorPane.timer = setTimeout(() => {
        if (session !== noteSession) return;
        preview.replaceChildren(renderMarkdown(state.notes.body));
        if (noteRefs?.words) noteRefs.words.textContent = `${countChars(state.notes.body)} 字`;
      }, 140);
    },
  });
  const modes = el("div", { class: "seg" }, [["split", "分屏"], ["edit", "编辑"], ["preview", "预览"]].map(([key, name]) =>
    el("button", { class: state.notes.mode === key ? "on" : "", text: name, onclick: () => { state.notes.mode = key; render(); } })
  ));

  const body =
    state.notes.mode === "edit"
      ? el("div", { class: "note-body single" }, editor)
      : state.notes.mode === "preview"
        ? el("div", { class: "note-body single" }, preview)
        : el("div", { class: "note-body" }, [editor, preview]);

  return el("div", {
    class: "note-editor",
    oncompositionstart: () => { if (session !== noteSession) return; noteComposing = true; clearTimeout(autoSaveTimer); },
    oncompositionend: () => { if (session !== noteSession) return; noteComposing = false; if (state.notes.dirty) scheduleAutoSave(); },
  }, [
    el("div", { class: "note-head" }, [
      el("input", {
        class: "note-title field",
        value: state.notes.title,
        placeholder: "笔记标题",
        oninput: (e) => { if (session !== noteSession) return; state.notes.title = e.target.value; markNoteDirty(); },
      }),
      el("input", {
        class: "field note-tags-input",
        value: state.notes.tagsText,
        placeholder: "标签，逗号分隔",
        oninput: (e) => { if (session !== noteSession) return; state.notes.tagsText = e.target.value; markNoteDirty(); },
      }),
    ]),
    el("div", { class: "pick note-toolbar" }, [
      el("button", {
        class: "ghost", text: "生成任务", title: "选中文字生成任务；未选中时使用笔记标题",
        onmousedown: (event) => event.preventDefault(),
        onclick: () => { if (session === noteSession) createTaskFromNote(noteSelectionText(editor, preview)); },
      }),
      el("button", { class: "primary", text: "保存 (Ctrl+S)", onclick: saveNote }),
      el("button", { class: "ghost", text: "版本历史", onclick: () => { if (session === noteSession) showNoteHistory(); } }),
      el("button", { class: "ghost", text: note.pinned ? "取消置顶" : "置顶", onclick: () => toggleNotePin(note) }),
      el("a", { class: "ghost", href: `/api/notes/${note.id}/export`, text: "导出此篇" }),
      el("button", { class: "ghost", text: "导出全部", onclick: () => { window.location.href = `/api/notes/export/all?${notesQuery()}`; } }),
      el("button", { class: "danger", text: "删除", onclick: () => deleteNote(note) }),
      modes,
      el("span", {
        class: "hint",
        id: "note-hint",
        text: noteStatusText(),
      }),
    ]),
    el("div", { id: "note-draft-status", class: `hint${state.notes.draftError ? " draft-warning" : ""}`, role: "status", text: noteDraftStatusText() }),
    el("div", { id: "note-recovery", class: "pick", hidden: !state.notes.saveError && !state.notes.draftError && !state.notes.restoredDraft }, [
      el("button", { class: "ghost", text: "下载当前草稿", onclick: () => downloadNoteDraft() }),
      el("button", { class: "ghost", text: "重新载入磁盘版本", onclick: reloadNote }),
    ]),
    noteLinkedTasks(),
    body,
    el("div", { class: "meta note-foot" }, [
      el("span", { id: "note-words", text: `${countChars(state.notes.body)} 字` }),
      el("span", { id: "note-file", text: `文件：notes/${note.file}.md` }),
      el("span", { text: `创建：${(note.createdAt ?? "").slice(0, 16).replace("T", " ")}` }),
    ]),
  ]);
}

function countChars(text) {
  const cjk = (String(text).match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  const latin = (String(text).match(/[A-Za-z0-9_'-]+/g) ?? []).length;
  return cjk + latin;
}

async function renderNotesView() {
  if (!state.notes.list) await loadNotes();
  if (state.notes.showTrash) state.notes.trash = (await api("/api/notes/trash")).items;
  noteRefs = null;
  const wrap = el("div", { class: "notes" }, [noteListPane(), noteEditorPane()]);
  noteRefs = {
    id: state.notes.currentId,
    list: wrap.querySelector("#note-list"),
    hint: wrap.querySelector("#note-hint"),
    title: wrap.querySelector(".note-title"),
    words: wrap.querySelector("#note-words"),
    file: wrap.querySelector("#note-file"),
    recovery: wrap.querySelector("#note-recovery"),
    drafts: wrap.querySelector("#note-drafts"),
    draftStatus: wrap.querySelector("#note-draft-status"),
  };
  return wrap;
}

/* ---------------- 渲染调度 ---------------- */
const TABS = [["tasks", "任务"], ["notes", "笔记"], ["stats", "统计报表"], ["review", "阶段回顾"], ["settings", "设置"]];

function renderTabs() {
  $("#tabs").replaceChildren(
    ...TABS.map(([key, name]) => el("button", { class: state.tab === key ? "active" : "", text: name, onclick: () => { state.tab = key; render(); } }))
  );
}

async function render() {
  renderTabs();
  renderSidebar();
  renderReminders();
  renderDrawer();
  $("#clock").textContent = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  const content = $("#content");
  try {
    if (state.tab === "tasks") content.replaceChildren(renderTaskView());
    else if (state.tab === "notes") content.replaceChildren(await renderNotesView());
    else if (state.tab === "stats") await renderStatsView();
    else if (state.tab === "review") await renderReviewView();
    else await renderSettingsView();
  } catch (error) {
    // 视图数据要过网络；失败时就地给出原因，不让界面静默停在原处
    content.replaceChildren(el("div", { class: "empty" }, `视图加载失败：${error.message}`));
    toast(error.message, true);
  }
}

async function run(action) {
  try {
    await action();
    const data = await api("/api/state");
    if (data.reminders?.length) notify(data.reminders);
    state.data = data;
    state.reminders = data.reminders ?? [];
    await render();
  } catch (error) {
    toast(error.message, true);
  }
}

let pollTimer = null;
let installPrompt = null;
function restartPolling() {
  clearInterval(pollTimer);
  const seconds = Math.max(10, Number(state.data?.settings?.reminderPollSeconds) || 60);
  pollTimer = setInterval(async () => {
    try {
      const res = await api("/api/reminders");
      const changed = res.reminders.length !== state.reminders.length || res.reminders.some((r, i) => state.reminders[i]?.id !== r.id);
      if (!changed) return;
      state.reminders = res.reminders;
      const data = await api("/api/state");
      state.data = data;
      notify(res.reminders);
      // 笔记/设置页可能正在输入，重建 DOM 会丢光标与未保存内容，只刷新外壳
      if (state.tab === "notes" || state.tab === "settings") {
        renderTabs();
        renderSidebar();
        renderReminders();
        renderDrawer();
      } else render();
    } catch {
      /* 服务暂不可达时静默重试 */
    }
  }, seconds * 1000);
}

function wire() {
  $("#note-history-close").addEventListener("click", closeNoteHistory);
  $("#note-history-dialog").addEventListener("cancel", (event) => { event.preventDefault(); closeNoteHistory(); });
  $("#note-history-refresh").addEventListener("click", loadNoteHistory);
  $("#note-history-restore").addEventListener("click", restoreNoteHistory);
  $("#global-search-open").addEventListener("click", showGlobalSearch);
  $("#global-search-close").addEventListener("click", closeGlobalSearch);
  $("#global-search-dialog").addEventListener("cancel", (e) => { e.preventDefault(); if (!searchPanel.composing) closeGlobalSearch(); });
  $("#global-search-clear").addEventListener("click", () => {
    $("#global-search-input").value = "";
    scheduleGlobalSearch(true);
    $("#global-search-input").focus();
  });
  $("#global-search-clear-recent").addEventListener("click", () => {
    clearRecentOpened();
    searchPanel.results.recent = [];
    renderGlobalSearch();
  });
  $("#global-search-retry").addEventListener("click", () => { searchPanel.tasksRequest = null; void loadGlobalSearch(); });
  const globalInput = $("#global-search-input");
  globalInput.addEventListener("input", (e) => { if (!e.isComposing && !searchPanel.composing) scheduleGlobalSearch(); });
  globalInput.addEventListener("compositionstart", () => {
    searchPanel.composing = true;
    clearTimeout(searchPanel.timer);
    searchPanel.seq++;
    searchPanel.loading = true;
    renderGlobalSearch();
  });
  globalInput.addEventListener("compositionend", () => { searchPanel.composing = false; scheduleGlobalSearch(); });
  globalInput.addEventListener("keydown", (e) => {
    if (e.isComposing || searchPanel.composing || e.keyCode === 229) return;
    const count = searchPanel.items.length;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && count) {
      e.preventDefault();
      searchPanel.active = (searchPanel.active + (e.key === "ArrowDown" ? 1 : -1) + count) % count;
      updateSearchActive();
      $(`#search-result-${searchPanel.active}`).scrollIntoView({ block: "nearest" });
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (count) void openSearchResult(searchPanel.items[searchPanel.active]);
    }
  });
  $("#search").addEventListener("input", (e) => {
    state.search = e.target.value;
    if (state.tab !== "tasks") state.tab = "tasks";
    render();
  });
  $("#sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    render();
  });
  $("#add-project").addEventListener("click", addProject);
  $("#notify-btn").addEventListener("click", async () => {
    if (!("Notification" in window)) return toast("当前浏览器不支持系统通知", true);
    const permission = await Notification.requestPermission();
    toast(permission === "granted" ? "已开启系统通知" : "浏览器已拒绝通知权限", permission !== "granted");
  });
  document.addEventListener("keydown", (e) => {
    if (noteHistory.open) {
      if ((e.ctrlKey || e.metaKey) && ["k", "s"].includes(e.key.toLowerCase())) e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      showGlobalSearch();
      return;
    }
    if (searchPanel.open) return;
    if (e.key === "Escape" && state.selected) closeTask();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (state.tab === "notes") saveNote();
    }
  });
  $("#note-file-input").addEventListener("change", onNoteFiles);
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key.startsWith(NOTE_DRAFT_PREFIX)) refreshNoteDrafts();
  });
  window.addEventListener("beforeunload", (e) => {
    if (state.notes.dirty || state.notes.saving || noteHistory.writing) e.preventDefault();
  });
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    $("#install-btn").hidden = false;
  });
  $("#install-btn").addEventListener("click", async () => {
    if (!installPrompt) return toast("浏览器还没给出安装入口，也可以点地址栏右侧的安装图标", true);
    installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    toast(choice.outcome === "accepted" ? "已安装，可在桌面或开始菜单找到「本地任务与笔记」" : "已取消安装");
    installPrompt = null;
    $("#install-btn").hidden = true;
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    $("#install-btn").hidden = true;
    toast("安装完成");
  });
}

async function boot() {
  wire();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  try {
    state.data = await api("/api/state");
    state.reminders = state.data.reminders ?? [];
  } catch (error) {
    const offline = !navigator.onLine || /fetch failed|failed to fetch|networkerror/i.test(String(error.message));
    $("#content").replaceChildren(
      el("div", { class: "empty" }, [
        el("div", { text: offline ? "本地服务没有在运行" : `加载失败：${error.message}` }),
        offline
          ? el("div", { class: "hint", text: "在项目目录执行 node server.js（或 npm start）后刷新。界面已离线缓存，任何时候都能打开。", style: "margin-top:6px" })
          : null,
      ])
    );
    return;
  }
  $("#sort").value = state.sort;
  const params = new URLSearchParams(location.search);
  const wantsNewNote = params.get("new") === "note";
  const wantsNewTask = params.get("new") === "task";
  const tab = wantsNewNote ? "notes" : wantsNewTask ? "tasks" : params.get("view");
  if (TABS.some(([key]) => key === tab)) state.tab = tab;
  if (wantsNewTask) state.selected = { id: "new" };
  await render();
  if (wantsNewNote) await newNote();
  restartPolling();
  if (state.reminders.length) notify(state.reminders);
}

boot();
