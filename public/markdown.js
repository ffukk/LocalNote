/**
 * 极简 Markdown 渲染：只用 DOM API 构建节点，绝不注入原始 HTML，
 * 因此笔记里写的 <script> / onerror 之类内容只会作为文本显示。
 */

const SAFE_LINK = /^(https?:|mailto:|tel:|#|\/)/i;
const SAFE_IMG = /^(https?:|data:image\/)/i;

function node(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = String(value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else el.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

const URL_PART = "(?:[^()]|\\([^()]*\\))*";
// 外层必须是捕获组：split(带捕获组的正则) 才会把命中的标记一起留在结果里
const INLINE_RE = new RegExp(
  `(${[
    "`[^`]+`",
    `!\\[[^\\]]*\\]\\(${URL_PART}\\)`,
    `\\[[^\\]]*\\]\\(${URL_PART}\\)`,
    "\\*\\*[^*]+\\*\\*",
    "__[^_]+__",
    "~~[^~]+~~",
    "(?<![\\w*])\\*[^*\\n]+\\*",
    "(?<![\\w_])_[^_\\n]+_",
  ].join("|")})`,
  "g"
);

function pushText(target, text) {
  target.appendChild(document.createTextNode(String(text)));
}

function inline(text, target) {
  const parts = String(text ?? "").split(INLINE_RE);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      target.appendChild(node("code", { text: part.slice(1, -1) }));
      continue;
    }
    const img = new RegExp(`^!\\[([^\\]]*)\\]\\((${URL_PART})\\)$`).exec(part);
    if (img) {
      const src = img[2].trim();
      if (SAFE_IMG.test(src)) target.appendChild(node("img", { src, alt: img[1], loading: "lazy" }));
      else pushText(target, img[1] || src);
      continue;
    }
    const link = new RegExp(`^\\[([^\\]]*)\\]\\((${URL_PART})\\)$`).exec(part);
    if (link) {
      const href = link[2].trim();
      if (SAFE_LINK.test(href)) {
        const a = node("a", { href, target: href.startsWith("#") || href.startsWith("/") ? null : "_blank", rel: "noopener noreferrer" });
        inline(link[1], a);
        target.appendChild(a);
      } else {
        pushText(target, link[1]);
      }
      continue;
    }
    if (/^\*\*[^*]+\*\*$/.test(part)) wrap(part, 2, "strong", target);
    else if (/^__[^_]+__$/.test(part)) wrap(part, 2, "strong", target);
    else if (/^~~[^~]+~~$/.test(part)) wrap(part, 2, "del", target);
    else if (/^\*[^*\n]+\*$/.test(part)) wrap(part, 1, "em", target);
    else if (/^_[^_\n]+_$/.test(part)) wrap(part, 1, "em", target);
    else pushText(target, part);
  }
  return target;
}

function wrap(part, marker, tag, target) {
  const el = node(tag);
  inline(part.slice(marker, -marker), el);
  target.appendChild(el);
  return target;
}

const isListItem = (line) => /^(\s*)([-*+]|\d+[.)])\s+/.test(line);

/** 列表：按缩进层级递归，支持 - [ ] 任务项。 */
function buildList(lines, start, indent) {
  const ordered = /^\s*\d+[.)]\s+/.test(lines[start]);
  const list = node(ordered ? "ol" : "ul", { class: "md-list" });
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      const next = lines[i + 1];
      if (next && isListItem(next) && leadingIndent(next) > indent) {
        i += 1;
        continue;
      }
      break;
    }
    if (!isListItem(line)) break;
    const thisIndent = leadingIndent(line);
    if (thisIndent < indent) break;
    if (thisIndent > indent) {
      const nested = buildList(lines, i, thisIndent);
      const lastItem = list.lastElementChild;
      (lastItem ?? list).appendChild(nested.list);
      i = nested.next;
      continue;
    }
    const content = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
    const task = /^\[([ xX])\]\s+/.exec(content);
    const li = node("li", { class: task ? "md-task" : null });
    if (task) {
      const box = node("input", { type: "checkbox", class: "md-check" });
      box.checked = task[1].toLowerCase() === "x";
      box.disabled = true;
      li.appendChild(box);
      inline(content.replace(/^\[[ xX]\]\s+/, ""), li);
    } else {
      inline(content, li);
    }
    list.appendChild(li);
    i += 1;
  }
  return { list, next: i };
}

function leadingIndent(line) {
  return /^(\s*)/.exec(line)[1].replace(/\t/g, "  ").length;
}

function buildTable(lines, start) {
  const cells = (line) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
  const head = cells(lines[start]);
  const aligns = cells(lines[start + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
  const table = node("table", { class: "md-table" });
  const thead = node("thead");
  const hr = node("tr");
  head.forEach((c, idx) => {
    const th = node("th", { style: `text-align:${aligns[idx] ?? "left"}` });
    inline(c, th);
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = node("tbody");
  let i = start + 2;
  while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
    const tr = node("tr");
    cells(lines[i]).forEach((c, idx) => {
      const td = node("td", { style: `text-align:${aligns[idx] ?? "left"}` });
      inline(c, td);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
    i += 1;
  }
  table.appendChild(tbody);
  return { table, next: i };
}

export function renderMarkdown(source) {
  const frag = document.createDocumentFragment();
  const lines = String(source ?? "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i += 1;
      const pre = node("pre", { class: "md-pre" });
      pre.appendChild(node("code", { text: buf.join("\n"), dataset: { lang: fence[1] || "" } }));
      frag.appendChild(pre);
      continue;
    }
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const h = node(`h${heading[1].length}`, { class: `md-h md-h${heading[1].length}` });
      inline(heading[2], h);
      frag.appendChild(h);
      i += 1;
      continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      frag.appendChild(node("hr", { class: "md-hr" }));
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      const quote = node("blockquote", { class: "md-quote" });
      for (const text of buf) {
        const p = node("p", { class: "md-quote-p" });
        inline(text, p);
        quote.appendChild(p);
      }
      frag.appendChild(quote);
      continue;
    }
    if (isListItem(line)) {
      const { list, next } = buildList(lines, i, leadingIndent(line));
      frag.appendChild(list);
      i = next;
      continue;
    }
    if (line.includes("|") && lines[i + 1] && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes("|")) {
      const { table, next } = buildTable(lines, i);
      frag.appendChild(table);
      i = next;
      continue;
    }
    // 缩进 4 空格（或制表符）起为代码块，便于直接粘 JSON / 日志
    if (/^(?: {4}|\t)/.test(line)) {
      const buf = [];
      while (i < lines.length && (!lines[i].trim() || /^(?: {4}|\t)/.test(lines[i]))) {
        buf.push(lines[i++].replace(/^ {4}/, "").replace(/^\t/, ""));
      }
      while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
      const pre = node("pre", { class: "md-pre" });
      pre.appendChild(node("code", { text: buf.join("\n"), dataset: { lang: "indent" } }));
      frag.appendChild(pre);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !isListItem(lines[i]) && !/^\s*(#{1,6}\s|>|```)/.test(lines[i]) && !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[i])) {
      para.push(lines[i]);
      i += 1;
      if (lines[i] && lines[i].includes("|") && lines[i + 1] && lines[i + 1].includes("|") && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[i + 1])) break;
    }
    const p = node("p", { class: "md-p" });
    para.forEach((text, idx) => {
      if (idx) p.appendChild(node("br"));
      inline(text, p);
    });
    frag.appendChild(p);
  }
  return frag;
}
