// 世界容器的缩放/平移:transform 应用、Ctrl+wheel 以光标为锚缩放、空白拖拽平移
import { clamp, qs } from "./dom.js"
import { state } from "./state.js"

export const MIN_SCALE = 0.05
export const MAX_SCALE = 2

let viewport: HTMLDivElement
let world: HTMLDivElement
let zoomLabel: HTMLElement
const listeners: Array<() => void> = []

/** 视图变了(缩放/平移/布局)之后要重算的东西:高亮框、缩放标签等 */
export function onViewChange(fn: () => void): void {
  listeners.push(fn)
}

// ---------- 视图持久化:刷新/重启后回到上次的位置与缩放 ----------

/** 按项目分键:多项目共用同一端口时 localStorage 不互相踩 */
function viewKey(): string {
  return `cs-view:${state.info?.projectRoot ?? "unknown"}`
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function persistView(): void {
  // 走查模式是临时视图(Esc 会还原),不落盘;落的是它进入前记住的浏览视图
  const v =
    state.mode === "review" && state.viewBeforeReview
      ? state.viewBeforeReview
      : { tx: state.tx, ty: state.ty, scale: state.scale }
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(viewKey(), JSON.stringify(v))
    } catch {
      /* 隐私模式等存不了就算了 */
    }
  }, 300)
}

/** state.info 就位后调用:恢复上次视图,没存过返回 false(用默认位置) */
export function restoreView(): boolean {
  try {
    const raw = localStorage.getItem(viewKey())
    if (!raw) return false
    const v = JSON.parse(raw) as { tx: number; ty: number; scale: number }
    if (![v.tx, v.ty, v.scale].every(Number.isFinite)) return false
    setView(v.tx, v.ty, v.scale)
    return true
  } catch {
    return false
  }
}

let raf = 0
export function applyView(): void {
  world.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`
  // pin 之类的 UI 用反向缩放抵消,保持恒定视觉大小
  world.style.setProperty("--cs-inv", String(1 / state.scale))
  // 点阵背景跟着一起动,平移缩放才有"真实空间"的手感
  const grid = 24 * state.scale
  viewport.style.backgroundSize = `${grid}px ${grid}px`
  viewport.style.backgroundPosition = `${state.tx}px ${state.ty}px`
  zoomLabel.textContent = `${Math.round(state.scale * 100)}%`
  persistView()
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    for (const fn of listeners) fn()
  })
}

export function setView(tx: number, ty: number, scale: number): void {
  state.scale = clamp(scale, MIN_SCALE, MAX_SCALE)
  state.tx = tx
  state.ty = ty
  applyView()
}

/** 以屏幕上某点为锚缩放 */
/** 世界内容的包围盒(世界坐标)。空墙返回 null */
function worldBounds(): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const b of state.boards.values()) {
    if (b.el.hidden) continue // 隐藏的画板不该把包围盒撑大
    const x = parseFloat(b.el.style.left || "0")
    const y = parseFloat(b.el.style.top || "0")
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + b.width)
    maxY = Math.max(maxY, y + b.height + 40)
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** 平滑地把视图移到目标值;拖拽/滚轮不走这里(那些必须跟手,不能带过渡)。
 *  ⚠️ 过渡期间 state 已是终值、DOM 还在半路,任何读几何的监听者(高亮框、pin 锚点)
 *  这一帧算出来的都是错的,而 applyView 只在开头触发过一次 —— 所以过渡结束后必须再补一次,
 *  否则错位会永久钉在那里。 */
function animateTo(tx: number, ty: number, scale: number): void {
  const world = qs<HTMLDivElement>("#cs-world")
  world.style.transition = `transform var(--cs-dur-3) var(--cs-ease-out)`
  setView(tx, ty, scale)
  window.setTimeout(() => {
    world.style.transition = "" // 动画结束就摘掉,避免污染后续跟手操作
    applyView() // DOM 已到终点,让监听者按真实几何重算一次
  }, 260)
}

/** 可用视口:扣掉左侧栏,否则内容会被压在栏底下 */
export function usableViewport(): { x: number; y: number; width: number; height: number } {
  const vp = qs("#cs-viewport").getBoundingClientRect()
  const sb = document.getElementById("cs-sidebar")
  const off = sb && document.body.dataset.sidebar !== "off" ? sb.getBoundingClientRect().width : 0
  return { x: vp.x + off, y: vp.y, width: vp.width - off, height: vp.height }
}

/** 全景:一屏看完整面墙 */
export function fitAll(pad = 64): void {
  const b = worldBounds()
  if (!b) return
  const vp = usableViewport()
  const scale = clamp(
    Math.min((vp.width - pad * 2) / b.w, (vp.height - pad * 2) / b.h),
    MIN_SCALE,
    MAX_SCALE
  )
  animateTo(
    vp.x + vp.width / 2 - (b.x + b.w / 2) * scale,
    vp.y + vp.height / 2 - (b.y + b.h / 2) * scale,
    scale
  )
}

/** 聚焦到某块画板(默认当前活动板) */
export function fitBoard(id?: string | null, pad = 80): void {
  const board = state.boards.get(id ?? state.activeId ?? "")
  if (!board) return fitAll()
  const x = parseFloat(board.el.style.left || "0")
  const y = parseFloat(board.el.style.top || "0")
  const vp = usableViewport()
  const scale = clamp(
    Math.min((vp.width - pad * 2) / board.width, (vp.height - pad * 2) / (board.height + 40)),
    MIN_SCALE,
    MAX_SCALE
  )
  animateTo(
    vp.x + vp.width / 2 - (x + board.width / 2) * scale,
    vp.y + vp.height / 2 - (y + (board.height + 40) / 2) * scale,
    scale
  )
}

/** 缩放到 100%,保持视口中心不动 */
export function zoomReset(): void {
  const vp = usableViewport()
  const cx = vp.x + vp.width / 2
  const cy = vp.y + vp.height / 2
  const k = 1 / state.scale
  animateTo(cx - (cx - state.tx) * k, cy - (cy - state.ty) * k, 1)
}

/** 以视口中心为锚点步进缩放(+/- 键用) */
export function zoomStep(factor: number): void {
  const vp = usableViewport()
  zoomAt(vp.x + vp.width / 2, vp.y + vp.height / 2, factor)
}

export function zoomAt(clientX: number, clientY: number, factor: number): void {
  const next = clamp(state.scale * factor, MIN_SCALE, MAX_SCALE)
  if (next === state.scale) return
  const r = viewport.getBoundingClientRect()
  const cx = clientX - r.left
  const cy = clientY - r.top
  const k = next / state.scale
  state.tx = cx - (cx - state.tx) * k
  state.ty = cy - (cy - state.ty) * k
  state.scale = next
  applyView()
}

/** 事件目标算不算"空白"(空白处才拖动平移) */
function isBlank(target: EventTarget | null): boolean {
  const el = target as Element | null
  if (!el) return false
  return !el.closest(".cs-board")
}

export function initView(): void {
  viewport = qs<HTMLDivElement>("#cs-viewport")
  world = qs<HTMLDivElement>("#cs-world")
  zoomLabel = qs("#cs-zoom")

  viewport.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      // 气泡/输入框里的滚轮是要滚它自己的内容:别 preventDefault,更别拿去平移画布。
      // (此前在批注编辑框里滚动,滚的是整面墙 —— 输入长文时完全没法用)
      if ((e.target as Element | null)?.closest?.(".cs-pin-bubble, .cs-pin-input")) return
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+wheel / 触控板捏合(浏览器把捏合报成 ctrlKey 的 wheel)
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY / 260))
      } else {
        // 双指滚轮 = 平移
        state.tx -= e.deltaX
        state.ty -= e.deltaY
        applyView()
      }
    },
    { passive: false }
  )

  let panId: number | null = null
  let lastX = 0
  let lastY = 0
  viewport.addEventListener("pointerdown", (e: PointerEvent) => {
    // 空白处左键 或 任意处中键 → 平移
    if (!(e.button === 1 || (e.button === 0 && isBlank(e.target)))) return
    panId = e.pointerId
    lastX = e.clientX
    lastY = e.clientY
    viewport.classList.add("is-panning")
    viewport.setPointerCapture(e.pointerId)
  })
  viewport.addEventListener("pointermove", (e: PointerEvent) => {
    if (panId !== e.pointerId) return
    state.tx += e.clientX - lastX
    state.ty += e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
    applyView()
  })
  const endPan = (e: PointerEvent) => {
    if (panId !== e.pointerId) return
    panId = null
    viewport.classList.remove("is-panning")
  }
  viewport.addEventListener("pointerup", endPan)
  viewport.addEventListener("pointercancel", endPan)

  applyView()
}

export function isPanning(): boolean {
  return viewport.classList.contains("is-panning")
}
