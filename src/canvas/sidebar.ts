// 左侧图层列表:上=页面(带路由,点击聚焦),下=组件(按文件分组)。
// 搜索过滤、单条显隐;分区/文件分组可折叠(折叠态按项目存本机),标题行带批量显隐。
// 它替代了小地图 —— 缩略图只能回答"我在哪",列表还能回答"有什么、叫什么、去哪"。
import { h, qs } from "./dom.js"
import { state } from "./state.js"
import { fitBoard } from "./view.js"
import { groupLabel, isHidden, setHidden, toggleHidden } from "./wall.js"

let root: HTMLElement
let listEl: HTMLElement
let filter = ""
/**
 * 搜索期间的临时折叠态(默认全展开)。搜出来的东西不该藏在折叠里,
 * 但此刻的折叠动作也得当场生效 —— 所以另存一份,不污染持久化的那份。
 */
let searchCollapsed: Set<string> | null = null
/** aria-controls 要合法 id,而分组 key 里有 / 和 . —— 按渲染序号发号 */
let uid = 0

export function initSidebar(): void {
  root = qs("#cs-sidebar")
  root.textContent = ""

  const head = h("div", "cs-sb-head")
  const search = document.createElement("input")
  search.className = "cs-sb-search"
  search.type = "search"
  search.placeholder = "搜索画板…"
  search.addEventListener("input", () => {
    filter = search.value.trim().toLowerCase()
    // 进入/退出搜索都重置临时折叠态:搜索结果一律先摊开给人看
    searchCollapsed = filter ? new Set() : null
    renderSidebar()
  })
  // 输入框里的按键不该触发画布快捷键(1/2/c/p 都是单键)
  search.addEventListener("keydown", (e) => {
    e.stopPropagation()
    if (e.key === "Escape") {
      search.value = ""
      filter = ""
      searchCollapsed = null
      renderSidebar()
      search.blur()
    }
  })
  head.append(h("span", "cs-sb-title", "画板"), search)

  listEl = h("div", "cs-sb-list")
  // 焦点在列表里时,Enter/空格的含义是"按下这个按钮",不是画布的 Enter=走查。
  // modes.ts 在 document 上收 Enter 并 preventDefault,不拦住的话按钮根本按不下去。
  listEl.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && (e.target as HTMLElement).closest("button")) {
      e.stopPropagation()
    }
  })
  root.append(head, listEl)

  const toggle = qs("#cs-sb-toggle")
  toggle.addEventListener("click", () => {
    const closed = document.body.dataset.sidebar === "off"
    document.body.dataset.sidebar = closed ? "on" : "off"
    toggle.title = closed ? "收起列表" : "展开列表"
  })
  renderSidebar()
}

function match(text: string): boolean {
  return !filter || text.toLowerCase().includes(filter)
}

// ---------- 折叠态:按项目存本机(键与 wall.ts 的显隐表同构) ----------

function collapseKey(): string {
  return `cs-collapsed:${state.info?.projectRoot ?? "unknown"}`
}

function collapsedSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(collapseKey()) ?? "[]") as string[])
  } catch {
    return new Set()
  }
}

function isCollapsed(key: string): boolean {
  return searchCollapsed ? searchCollapsed.has(key) : collapsedSet().has(key)
}

function toggleCollapsed(key: string): void {
  if (searchCollapsed) {
    if (!searchCollapsed.delete(key)) searchCollapsed.add(key)
    return
  }
  const s = collapsedSet()
  if (s.has(key)) s.delete(key)
  else s.add(key)
  try {
    localStorage.setItem(collapseKey(), JSON.stringify([...s]))
  } catch {
    /* 存不了就只影响本次 */
  }
}

// ---------- 批量显隐 ----------

/** 一组画板的显隐三态:all=全显示 / some=部分隐藏 / none=全隐藏 */
type BulkMode = "all" | "some" | "none"

function bulkMode(ids: string[]): { mode: BulkMode; shown: number } {
  const shown = ids.filter((id) => !isHidden(id)).length
  return { mode: shown === ids.length ? "all" : shown === 0 ? "none" : "some", shown }
}

/** 把一组画板对齐到同一显隐状态:落盘和重排各只做一次 */
function setGroupHidden(ids: string[], hide: boolean): void {
  setHidden(ids, hide)
}

/**
 * 每次操作都整表重画,焦点所在的那个按钮会被换掉 —— 键盘用户按一次折叠就被弹回页首,
 * 连按两下都做不到。所以给每个按钮一个稳定 key,重画后把焦点还回原位。
 */
function focusedKey(): string | null {
  const el = document.activeElement as HTMLElement | null
  return el && listEl.contains(el) ? (el.dataset.fk ?? null) : null
}

function restoreFocus(key: string | null): void {
  if (!key) return
  const el = listEl.querySelector<HTMLElement>(`[data-fk="${CSS.escape(key)}"]`)
  el?.focus({ preventScroll: true }) // 别顺手把列表滚跑
}

/** 重画列表。数据源就是 state.entries,不另存一份,避免两处状态漂移 */
export function renderSidebar(): void {
  if (!listEl) return
  const keepFocus = focusedKey()
  listEl.textContent = ""
  uid = 0

  const screens = state.entries.filter((e) => e.kind === "screen")
  const comps = state.entries.filter((e) => e.kind !== "screen")

  // ---- 页面:平铺,副标题是真实路由 ----
  const visScreens = screens.filter((e) => match(e.exportName) || match(e.url ?? ""))
  if (visScreens.length) {
    const g = group("sec:screen", "页面", visScreens.map((e) => e.id), "cs-sb-section")
    for (const e of visScreens) g.body.appendChild(row(e.id, e.exportName, e.url ?? "", "screen"))
    listEl.appendChild(g.el)
  }

  // ---- 组件:按文件分组,每个文件自己也能折叠 ----
  const byFile = new Map<string, typeof comps>()
  for (const e of comps) {
    if (!(match(e.exportName) || match(groupLabel(e.file)))) continue
    const l = byFile.get(e.file)
    if (l) l.push(e)
    else byFile.set(e.file, [e])
  }
  if (byFile.size) {
    const files = [...byFile.keys()].sort()
    const allIds = files.flatMap((f) => (byFile.get(f) ?? []).map((e) => e.id))
    const g = group("sec:component", "组件", allIds, "cs-sb-section")
    for (const file of files) {
      const list = byFile.get(file) ?? []
      const fg = group(`file:${file}`, groupLabel(file), list.map((e) => e.id), "cs-sb-file")
      for (const e of list) fg.body.appendChild(row(e.id, e.exportName, "", "component"))
      g.body.appendChild(fg.el)
    }
    listEl.appendChild(g.el)
  }

  if (!listEl.childElementCount) {
    listEl.appendChild(h("div", "cs-sb-empty", filter ? "没有匹配的画板" : "还没有画板"))
  }
  syncActive()
  restoreFocus(keepFocus)
}

/**
 * 一个可折叠分组:标题行(折叠按钮 + 批量显隐按钮)+ 内容容器。
 * 两个按钮是两个独立的点击目标,谁也不吃谁的事件 —— 折叠不该顺手把一组画板藏掉。
 */
function group(
  key: string,
  label: string,
  ids: string[],
  headCls: string
): { el: HTMLElement; body: HTMLElement } {
  const el = h("div", "cs-sb-group")
  if (headCls === "cs-sb-file") el.classList.add("is-file")
  const headEl = h("div", headCls)
  const body = h("div", "cs-sb-items")
  body.id = `cs-sb-g${++uid}`
  const collapsed = isCollapsed(key)
  body.hidden = collapsed // 折叠的内容连 Tab 都到不了,不留幽灵焦点

  const { mode, shown } = bulkMode(ids)

  const caret = h("button", "cs-sb-caret")
  caret.type = "button"
  caret.dataset.fk = `caret:${key}`
  caret.setAttribute("aria-expanded", String(!collapsed))
  caret.setAttribute("aria-controls", body.id)
  caret.title = collapsed ? `展开「${label}」` : `折叠「${label}」`
  const arrow = h("span", "cs-sb-arrow", "▸")
  arrow.setAttribute("aria-hidden", "true") // 纯装饰,可访问名由下面的文字给
  // 计数同时是三态的第二处线索:全显示只报总数,有隐藏就报"显示中/总数"
  const count = h("span", "cs-sb-count", mode === "all" ? String(ids.length) : `${shown}/${ids.length}`)
  caret.append(arrow, h("span", "cs-sb-label", label), count)
  caret.addEventListener("click", () => {
    toggleCollapsed(key)
    renderSidebar()
  })

  const bulk = h("button", "cs-sb-bulk", mode === "all" ? "●" : mode === "none" ? "◌" : "◐")
  bulk.type = "button"
  bulk.dataset.fk = `bulk:${key}`
  bulk.dataset.state = mode
  // 三态直接映射到 aria-pressed 的三值,读屏能听出"部分"
  bulk.setAttribute("aria-pressed", mode === "all" ? "true" : mode === "none" ? "false" : "mixed")
  const act = mode === "all" ? `隐藏「${label}」下全部 ${ids.length} 块画板` : `显示「${label}」下全部 ${ids.length} 块画板`
  bulk.setAttribute("aria-label", act)
  bulk.title = mode === "some" ? `${act}(当前 ${shown}/${ids.length} 显示中)` : act
  bulk.addEventListener("click", (e) => {
    e.stopPropagation()
    setGroupHidden(ids, mode === "all") // 全显 → 全隐;部分/全隐 → 全显(先把人捞回全见)
    renderSidebar()
  })

  headEl.append(caret, bulk)
  el.append(headEl, body)
  return { el, body }
}

function row(id: string, name: string, sub: string, kind: string): HTMLElement {
  const el = h("div", "cs-sb-row")
  el.dataset.id = id

  const go = h("button", "cs-sb-go")
  go.type = "button"
  go.dataset.fk = `go:${id}`
  go.dataset.kind = kind
  go.title = sub ? `聚焦 ${name} (${sub})` : `聚焦 ${name}`
  go.append(h("span", "cs-sb-dot"), h("span", "cs-sb-name", name))
  if (sub) go.appendChild(h("span", "cs-sb-route", sub))
  go.addEventListener("click", () => {
    if (isHidden(id)) toggleHidden(id) // 藏着的先亮出来再聚焦,否则点了没反应
    fitBoard(id)
    state.activeId = id
    syncActive()
  })

  const eye = h("button", "cs-sb-eye", isHidden(id) ? "◌" : "●")
  eye.type = "button"
  eye.dataset.fk = `eye:${id}`
  eye.title = isHidden(id) ? "显示这块画板" : "从墙上隐藏(不删,随时点回来)"
  eye.setAttribute("aria-label", isHidden(id) ? `显示 ${name}` : `隐藏 ${name}`)
  eye.setAttribute("aria-pressed", String(!isHidden(id)))
  eye.addEventListener("click", (e) => {
    e.stopPropagation()
    toggleHidden(id)
    renderSidebar()
  })

  el.append(go, eye)
  if (isHidden(id)) el.classList.add("is-hidden-board")
  return el
}

/** 活动画板在列表里高亮 —— 这是"我在哪"的答案 */
export function syncActive(): void {
  if (!listEl) return
  for (const r of listEl.querySelectorAll<HTMLElement>(".cs-sb-row")) {
    r.classList.toggle("is-active", r.dataset.id === state.activeId)
  }
}
