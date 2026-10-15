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
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
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
  notes: { list: null, q: "", tag: "", pinned: "", currentId: null, current: null, title: "", tagsText: "", body: "", dirty: false, mode: "split" },
  reminders: [],
};

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
function openTask(id, opts = {}) {
  state.selected = { id, addSub: Boolean(opts.addSub) };
  render();
}
function closeTask() {
  state.selected = null;
  render();
}

function renderDrawer() {
  const drawer = $("#drawer");
  if (!state.selected) {
    drawer.hidden = true;
    drawer.replaceChildren();
    return;
  }
  drawer.hidden = false;
  const all = [...state.data.tasks, ...state.data.trashed];
  const isNew = state.selected.id === "new";
  const task = isNew ? null : all.find((t) => t.id === state.selected.id);
  if (!isNew && !task) {
    drawer.replaceChildren(el("div", { class: "empty" }, "任务已不存在"));
    return;
  }
  const repeat = task?.repeat ?? { rule: "none" };
  const parentId = isNew ? state.selected.parentId ?? null : task.parentId;
  const parent = parentId ? all.find((t) => t.id === parentId) : null;
  const children = isNew ? [] : childTasks(task.id);

  const form = el("div", { class: "form" });

  form.appendChild(el("label", {}, ["标题", el("input", { class: "field", id: "f-title", value: task?.title ?? state.selected.prefill ?? "", placeholder: "要做什么" })]));
  if (parent) form.appendChild(el("div", { class: "hint", text: `子任务 · 父任务：${parent.title}` }));
  form.appendChild(el("label", {}, ["备注", el("textarea", { class: "field", id: "f-notes", text: task?.notes ?? "" })]));
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

  const save = async () => {
    const body = collect();
    await run(async () => {
      if (isNew) {
        if (parentId) body.parentId = parentId;
        const res = await api("/api/tasks", { method: "POST", body });
        state.selected = { id: res.task.id };
      } else {
        await api(`/api/tasks/${task.id}`, { method: "PATCH", body });
      }
      toast("已保存");
    });
  };

  form.appendChild(
    el("div", { class: "foot" }, [
      el("button", { class: "primary", text: isNew ? "创建任务" : "保存修改", onclick: save }),
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
function renderSettingsView() {
  const s = state.data.settings;
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
    ])
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

/** PATCH 之后用刷新出的列表回写当前笔记元数据，避免工具栏状态滞后。 */
function syncCurrentNote() {
  if (!state.notes.currentId) return;
  const fresh = state.notes.list?.notes.find((n) => n.id === state.notes.currentId) ?? null;
  if (!fresh) {
    state.notes.currentId = null;
    state.notes.current = null;
    state.notes.body = "";
    state.notes.dirty = false;
    return;
  }
  state.notes.current = fresh;
  if (!state.notes.dirty) {
    state.notes.title = fresh.title;
    state.notes.tagsText = (fresh.tags ?? []).join(", ");
  }
}

function markNoteDirty() {
  if (!state.notes.dirty) {
    state.notes.dirty = true;
    if (noteRefs?.hint) noteRefs.hint.textContent = "未保存 · Ctrl+S 保存";
  }
}

async function openNote(id) {
  if (state.notes.dirty && !confirm("当前笔记有未保存的修改，切换后会丢弃，确定？")) return;
  const data = await api(`/api/notes/${id}`);
  state.notes.currentId = data.note.id;
  state.notes.current = data.note;
  state.notes.title = data.note.title;
  state.notes.tagsText = (data.note.tags ?? []).join(", ");
  state.notes.body = data.body;
  state.notes.dirty = false;
  await render();
}

async function newNote() {
  if (state.notes.dirty && !confirm("当前笔记有未保存的修改，新建会丢弃，确定？")) return;
  await runNotes(async () => {
    const res = await api("/api/notes", { method: "POST", body: { title: "未命名笔记", body: "" } });
    state.notes.currentId = res.note.id;
    state.notes.current = res.note;
    state.notes.title = res.note.title;
    state.notes.tagsText = "";
    state.notes.body = res.body ?? "";
    state.notes.dirty = false;
    state.notes.mode = "split";
  });
  noteRefs?.title?.focus();
}

async function saveNote() {
  if (!state.notes.currentId) return;
  await runNotes(async () => {
    const res = await api(`/api/notes/${state.notes.currentId}`, {
      method: "PATCH",
      body: { title: state.notes.title, tags: state.notes.tagsText, body: state.notes.body },
    });
    state.notes.current = res.note;
    state.notes.dirty = false;
    toast("笔记已保存");
  });
}

async function toggleNotePin(note) {
  await runNotes(() => api(`/api/notes/${note.id}`, { method: "PATCH", body: { pinned: !note.pinned } }));
}

async function deleteNote(note) {
  if (!confirm(`删除笔记「${note.title}」？\n对应文件 notes/${note.file}.md 会被移除，不可恢复。`)) return;
  await runNotes(async () => {
    await api(`/api/notes/${note.id}`, { method: "DELETE" });
    if (state.notes.currentId === note.id) {
      state.notes.currentId = null;
      state.notes.current = null;
      state.notes.body = "";
      state.notes.dirty = false;
    }
    toast("笔记已删除");
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
    placeholder: "搜索笔记标题与正文",
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
    ]),
    search,
    el("div", { class: "tag-cloud note-tags" }, [
      el("button", { class: state.notes.tag === "" ? "active" : "", text: "全部", onclick: () => { state.notes.tag = ""; render(); } }),
      ...(state.notes.list?.tags ?? []).map((tag) =>
        el("button", { class: state.notes.tag === tag ? "active" : "", text: tag, onclick: () => { state.notes.tag = state.notes.tag === tag ? "" : tag; render(); } })
      ),
    ]),
    el("div", { class: "note-list", id: "note-list" }, noteListItems()),
  ]);
}

function noteListItems() {
  const list = state.notes.list?.notes ?? [];
  if (!list.length) return [el("div", { class: "empty", text: state.notes.q ? "没有匹配的笔记" : "还没有笔记，点「新建笔记」或导入 .md 文件" })];
  return list.map((note) => {
    const selected = state.notes.currentId === note.id;
    const children = [
      el("div", { class: "note-item-title" }, [
        note.pinned ? el("span", { class: "pin", title: "已置顶", text: "📌" }) : null,
        el("span", { text: note.title }),
      ]),
      el("div", { class: "note-item-sub", text: `${(note.updatedAt ?? "").slice(0, 16).replace("T", " ")} · ${note.words} 字` }),
      note.excerpt ? el("div", { class: "note-item-ex", text: note.excerpt }) : null,
      note.tags.length ? el("div", { class: "note-item-tags" }, note.tags.map((t) => el("span", { class: "pill", text: `#${t}` }))) : null,
    ].filter(Boolean);
    return el("div", { class: `note-item${selected ? " on" : ""}`, onclick: () => openNote(note.id) }, children);
  });
}

function noteEditorPane() {
  if (!state.notes.currentId) {
    return el("div", { class: "note-editor" }, el("div", { class: "empty" }, [
      el("div", { text: "选择左侧笔记，或新建一条" }),
      el("div", { class: "hint", text: "笔记以 Markdown 文件存放在 notes/ 目录，可被其它编辑器直接修改。", style: "margin-top:8px" }),
    ]));
  }
  const note = state.notes.current;
  const preview = el("div", { class: "md-body" });
  preview.appendChild(renderMarkdown(state.notes.body));
  const editor = el("textarea", {
    class: "note-text",
    placeholder: "用 Markdown 写点什么…支持标题、列表、待办、代码块、表格、链接",
    value: state.notes.body,
    spellcheck: "false",
    oninput: (e) => {
      state.notes.body = e.target.value;
      markNoteDirty();
      clearTimeout(noteEditorPane.timer);
      noteEditorPane.timer = setTimeout(() => {
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

  return el("div", { class: "note-editor" }, [
    el("div", { class: "note-head" }, [
      el("input", {
        class: "note-title field",
        value: state.notes.title,
        placeholder: "笔记标题",
        oninput: (e) => { state.notes.title = e.target.value; markNoteDirty(); },
      }),
      el("input", {
        class: "field note-tags-input",
        value: state.notes.tagsText,
        placeholder: "标签，逗号分隔",
        oninput: (e) => { state.notes.tagsText = e.target.value; markNoteDirty(); },
      }),
    ]),
    el("div", { class: "pick note-toolbar" }, [
      el("button", { class: "primary", text: "保存 (Ctrl+S)", onclick: saveNote }),
      el("button", { class: "ghost", text: note.pinned ? "取消置顶" : "置顶", onclick: () => toggleNotePin(note) }),
      el("a", { class: "ghost", href: `/api/notes/${note.id}/export`, text: "导出此篇" }),
      el("button", { class: "ghost", text: "导出全部", onclick: () => { window.location.href = `/api/notes/export/all?${notesQuery()}`; } }),
      el("button", { class: "danger", text: "删除", onclick: () => deleteNote(note) }),
      modes,
      el("span", { class: "hint", id: "note-hint", text: state.notes.dirty ? "未保存 · Ctrl+S 保存" : `已保存 · ${(note.updatedAt ?? "").slice(0, 16).replace("T", " ")}` }),
    ]),
    body,
    el("div", { class: "meta note-foot" }, [
      el("span", { id: "note-words", text: `${countChars(state.notes.body)} 字` }),
      el("span", { text: `文件：notes/${note.file}.md` }),
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
  noteRefs = null;
  const wrap = el("div", { class: "notes" }, [noteListPane(), noteEditorPane()]);
  noteRefs = {
    list: wrap.querySelector("#note-list"),
    hint: wrap.querySelector("#note-hint"),
    title: wrap.querySelector(".note-title"),
    words: wrap.querySelector("#note-words"),
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
    else renderSettingsView();
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
    if (e.key === "Escape" && state.selected) closeTask();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      $("#search").focus();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (state.tab === "notes") saveNote();
    }
  });
  $("#note-file-input").addEventListener("change", onNoteFiles);
  window.addEventListener("beforeunload", (e) => {
    if (state.notes.dirty) e.preventDefault();
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
