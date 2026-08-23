// 同源反查:iframe 内元素定位、CSS selector 生成、外壳层描边框
import { clamp, frameDoc, h, qs } from "./dom.js"
import { state, type Board } from "./state.js"

let fx: HTMLDivElement
let hoverBox: HTMLDivElement
let selectBox: HTMLDivElement

/** hover 的是哪个元素(直接持引用,HMR 换 DOM 后自然失效) */
let hoverRef: { board: Board; el: Element } | null = null
/** 选中的记 selector,HMR 后仍能重新定位;el 是解析出来的缓存,断链后重查 */
let selectRef: { board: Board; selector: string; el: Element | null } | null = null

/** 一个框上次画成什么样:完全没变就整帧跳过(跟随循环靠这个停下来) */
interface Painted {
  sig: string
  /** 标签的实测尺寸,只在文案/可用宽变了才重量 */
  tagKey: string
  tagW: number
  tagH: number
}
const painted = new Map<HTMLDivElement, Painted>()

function makeBox(kind: "hover" | "select"): HTMLDivElement {
  const box = h("div", "cs-box")
  box.dataset.kind = kind
  box.appendChild(h("span", "cs-box-tag"))
  fx.appendChild(box)
  return box
}

export function initSelect(): void {
  fx = qs<HTMLDivElement>("#cs-fx")
  hoverBox = makeBox("hover")
  selectBox = makeBox("select")
}

// ---------- 坐标换算 ----------

/** 屏幕坐标 → iframe 内元素(世界缩放要除掉) */
export function elementAt(board: Board, clientX: number, clientY: number): Element | null {
  const doc = frameDoc(board.iframe)
  if (!doc || !board.iframe) return null
  const r = board.iframe.getBoundingClientRect()
  const s = liveScale(board, board.frameEl.getBoundingClientRect())
  let stack: Element[]
  try {
    stack = doc.elementsFromPoint((clientX - r.left) / s, (clientY - r.top) / s)
  } catch {
    return null
  }
  // screen 画板不过滤:那是一整个真实页面,body/容器就是页面本身
  if (board.entry.kind !== "component") return stack[0] ?? null
  // 组件画板:能被指着的必须是"画了东西"的元素。命中栈从最上层往下找第一个可见的;
  // 走到 html/body/注入的 wrapper 就停 —— 组件小、视口大时空白处命中的是一整片 body,
  // 而组件根往往是个透明的布局容器(grid/flex),高亮它们都是"选中了一大片看不见的面板"。
  // 指着空白 = 没指任何东西。
  for (const el of stack) {
    const t = el.tagName
    if (t === "HTML" || t === "BODY" || el.hasAttribute("data-cs-artboard")) return null
    if (paintsSomething(el, doc)) return el
  }
  return null
}

/** 天生可见的元素:替换元素与表单控件,不看样式就知道画了东西 */
const VISIBLE_TAGS = new Set([
  "IMG", "VIDEO", "CANVAS", "INPUT", "SELECT", "TEXTAREA", "BUTTON", "HR", "IFRAME",
  "PICTURE", "AUDIO", "EMBED", "OBJECT",
])

/** computed backgroundColor → alpha。现代浏览器可能给 lab()/oklch(),非 rgba 格式一律当不透明 */
function bgAlpha(bg: string): number {
  if (bg === "transparent") return 0
  const m = bg.match(/^rgba\([^)]*,\s*([\d.]+)\s*\)$/)
  return m ? parseFloat(m[1]) : 1
}

/** 这个元素在视觉上画了任何东西吗(底色/边框/阴影/图片/直接文本)?纯布局容器返回 false */
function paintsSomething(el: Element, doc: Document): boolean {
  if (VISIBLE_TAGS.has(el.tagName)) return true
  if (el.closest("svg")) return true
  for (const n of el.childNodes) {
    if (n.nodeType === 3 && n.textContent && n.textContent.trim()) return true // 直接文本节点
  }
  const win = doc.defaultView
  if (!win) return false
  const cs = win.getComputedStyle(el)
  if (cs.backgroundImage !== "none") return true
  if (bgAlpha(cs.backgroundColor) > 0) return true
  if (cs.boxShadow !== "none") return true
  if (
    (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0) +
    (parseFloat(cs.borderBottomWidth) || 0) + (parseFloat(cs.borderLeftWidth) || 0) > 0
  ) return true
  if (cs.outlineStyle !== "none" && (parseFloat(cs.outlineWidth) || 0) > 0) return true
  return false
}

/**
 * iframe 内元素的包围盒 → 屏幕坐标。
 * 缩放必须现量,不能用 state.scale:世界容器 #cs-world 的 transform 带 260ms 过渡
 * (view.ts 的 animateTo —— 全景 1 / 聚焦 2 / 100% 0 / 侧栏点条目都走它),过渡途中
 * state.scale 已是终值而 DOM 还停在半路,两者混用框就整体错位。
 */
function screenRect(board: Board, el: Element): DOMRect | null {
  if (!board.iframe || !board.el.isConnected) return null
  const fr = board.iframe.getBoundingClientRect()
  const s = liveScale(board, board.frameEl.getBoundingClientRect())
  const b = el.getBoundingClientRect()
  return new DOMRect(fr.left + b.left * s, fr.top + b.top * s, b.width * s, b.height * s)
}

/**
 * 这一瞬间画板真正被缩放成了几倍:.cs-frame 的 CSS 宽恒等于 board.width(wall.ts 的
 * applySize 写死),屏幕宽 ÷ 它就是当前生效的缩放,过渡动画中途也准。量不出来才退回 state.scale。
 */
function liveScale(board: Board, frame: DOMRect): number {
  if (board.width > 0 && frame.width > 0) return frame.width / board.width
  return state.scale || 1
}

/** 点击位置相对元素的 0-1 坐标 */
export function relPos(el: Element, clientX: number, clientY: number, board: Board): { x: number; y: number } {
  const r = screenRect(board, el)
  if (!r || r.width === 0 || r.height === 0) return { x: 0, y: 0 }
  const round = (v: number) => Math.round(clamp(v, 0, 1) * 1000) / 1000
  return { x: round((clientX - r.left) / r.width), y: round((clientY - r.top) / r.height) }
}

// ---------- selector 生成 ----------

function isUnique(doc: Document, sel: string): boolean {
  try {
    return doc.querySelectorAll(sel).length === 1
  } catch {
    return false
  }
}

function idSelector(el: Element): string | null {
  const id = el.getAttribute("id")
  if (!id) return null
  return `#${CSS.escape(id)}`
}

function dataSelector(el: Element): string | null {
  for (const attr of Array.from(el.attributes)) {
    if (!attr.name.startsWith("data-") || !attr.value) continue
    const v = attr.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    return `[${attr.name}="${v}"]`
  }
  return null
}

function nthPart(el: Element): string {
  const tag = el.localName
  const parent = el.parentElement
  if (!parent) return tag
  const sames = Array.from(parent.children).filter((c) => c.localName === tag)
  if (sames.length < 2) return tag
  return `${tag}:nth-of-type(${sames.indexOf(el) + 1})`
}

/** 优先 id,再 data-*,否则 标签+nth-of-type 链(最多 5 层) */
export function buildSelector(el: Element): string {
  const doc = el.ownerDocument
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && cur !== doc.documentElement && parts.length < 5) {
    const byId = idSelector(cur)
    if (byId && isUnique(doc, byId)) {
      parts.unshift(byId)
      return parts.join(" > ")
    }
    const byData = dataSelector(cur)
    if (byData && isUnique(doc, byData)) {
      parts.unshift(byData)
      return parts.join(" > ")
    }
    parts.unshift(nthPart(cur))
    const joined = parts.join(" > ")
    if (isUnique(doc, joined)) return joined
    cur = cur.parentElement
  }
  return parts.join(" > ") || el.localName
}

/** HUD 文案:tag / probe / 类名。注意 iframe 里的元素跨 realm,不能用 instanceof 判类型 */
export function describe(el: Element): string {
  const probe = el.closest("[data-probe]")?.getAttribute("data-probe")
  const cls = typeof el.className === "string" ? el.className : ""
  return (
    `<${el.localName}>` +
    (probe ? `  probe=${probe}` : "") +
    (cls ? `  .${cls.trim().split(/\s+/).slice(0, 3).join(".")}` : "")
  )
}

// ---------- 描边框 ----------

/** 标签与框之间的缝;贴边翻进框内时同样用它 */
const TAG_GAP = 1

/**
 * 标签(.cs-box-tag)必须留在画板的可视区里 —— 它是屏幕坐标层的东西,不受画板
 * overflow:hidden 约束,不管就会飘到画板外面的画布上。
 * 默认贴框的左上外侧;上面塞不下就翻到框内侧,再不行按可视区边缘压住。
 */
function placeTag(tag: HTMLElement, box: DOMRect, frame: DOMRect, st: Painted, label: string): void {
  // 长 selector 不许顶穿画板:可用宽给死,超出部分由 style-select.css 的省略号收尾
  const maxW = Math.max(24, Math.floor(frame.width) - 2)
  const key = `${label}|${maxW}`
  if (st.tagKey !== key) {
    tag.style.maxWidth = `${maxW}px`
    const t = tag.getBoundingClientRect()
    // 量到 0 说明框这一刻还是 display:none(调用方必须先 is-on 再来),不缓存,下一帧重量
    st.tagKey = t.height > 0 ? key : ""
    st.tagW = t.width
    st.tagH = t.height
  }
  let x = box.left
  let y = box.top - st.tagH - TAG_GAP
  if (y < frame.top) y = box.top + TAG_GAP // 顶边贴住了 → 翻到框内侧
  y = clamp(y, frame.top, Math.max(frame.top, frame.bottom - st.tagH))
  x = clamp(x, frame.left, Math.max(frame.left, frame.right - st.tagW))
  // .cs-box 是 border-box + 1px 边框,标签的包含块是它的 padding box,所以要各减 1
  tag.style.left = `${x - box.left - 1}px`
  tag.style.top = `${y - box.top - 1}px`
}

/** 画一个框。返回 true = 这次真改了 DOM(跟随循环靠它判断"还在动") */
function paint(box: HTMLDivElement, board: Board, el: Element, label: string): boolean {
  const r = screenRect(board, el)
  if (!r || r.width + r.height === 0) {
    const off = box.classList.contains("is-on")
    box.classList.remove("is-on")
    return off
  }
  const frame = board.frameEl.getBoundingClientRect()
  const sig = `${r.left},${r.top},${r.width},${r.height}|${frame.left},${frame.top},${frame.width},${frame.height}|${label}`
  let st = painted.get(box)
  if (st && st.sig === sig && box.classList.contains("is-on")) return false
  if (!st) {
    st = { sig, tagKey: "", tagW: 0, tagH: 0 }
    painted.set(box, st)
  }
  st.sig = sig
  box.style.left = `${r.left}px`
  box.style.top = `${r.top}px`
  box.style.width = `${r.width}px`
  box.style.height = `${r.height}px`
  const tag = box.firstElementChild as HTMLElement
  if (tag.textContent !== label) tag.textContent = label
  // 先亮起来再摆标签:框还是 display:none 的话,标签量出来是 0×0,翻边/夹边全算错
  box.classList.add("is-on")
  placeTag(tag, r, frame, st, label)
  return true
}

/** 选中框的元素:缓存住,断链(HMR 换 DOM)了再按 selector 重查 */
function resolveSelected(): Element | null {
  if (!selectRef) return null
  if (selectRef.el?.isConnected) return selectRef.el
  const doc = frameDoc(selectRef.board.iframe)
  try {
    selectRef.el = doc ? doc.querySelector(selectRef.selector) : null
  } catch {
    selectRef.el = null
  }
  return selectRef.el
}

/** 把两个框都按当前几何画一遍,返回是否有变化 */
function paintAll(): boolean {
  let changed = false
  if (hoverRef) {
    if (hoverRef.el.isConnected) {
      changed = paint(hoverBox, hoverRef.board, hoverRef.el, hoverRef.el.localName) || changed
    } else {
      hideHover()
      changed = true
    }
  }
  if (selectRef) {
    const el = resolveSelected()
    if (el) changed = paint(selectBox, selectRef.board, el, selectRef.selector) || changed
    else if (selectBox.classList.contains("is-on")) {
      selectBox.classList.remove("is-on")
      changed = true
    }
  }
  return changed
}

// ---------- 跟随 ----------
//
// refreshBoxes() 只在"视图变化那一刻"被调一次,而世界容器的 transform 带 260ms 过渡
// (view.ts 的 animateTo),画板自动测高、iframe 内容重排也都不是一帧就完事的 ——
// 只画一次,框就停在半路上再也不动了。
// 所以这里让框跟到停:每帧只重算当前亮着的那 1~2 个框,连续 STILL_FRAMES 帧几何没变
// 就自己停掉(静止悬停时不烧帧),视图再变时由 refreshBoxes/showHover 唤醒。
const STILL_FRAMES = 24
let followRaf = 0
let stillFrames = 0

function follow(): void {
  followRaf = 0
  if (!hoverRef && !selectRef) return
  stillFrames = paintAll() ? 0 : stillFrames + 1
  if (stillFrames < STILL_FRAMES) followRaf = requestAnimationFrame(follow)
}

function wake(): void {
  stillFrames = 0
  if (!followRaf && (hoverRef || selectRef)) followRaf = requestAnimationFrame(follow)
}

export function showHover(board: Board, el: Element): void {
  hoverRef = { board, el }
  paint(hoverBox, board, el, el.localName)
  wake()
}

export function hideHover(): void {
  hoverRef = null
  hoverBox.classList.remove("is-on")
}

export function showSelection(board: Board, selector: string): void {
  selectRef = { board, selector, el: null }
  refreshBoxes()
}

export function clearSelection(): void {
  selectRef = null
  selectBox.classList.remove("is-on")
}

/** 平移/缩放/重排后重画两个框(视图变化的入口,同时唤醒跟随) */
export function refreshBoxes(): void {
  if (hoverRef && !hoverRef.el.isConnected) hideHover()
  paintAll()
  wake()
}
