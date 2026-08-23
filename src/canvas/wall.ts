// 墙:位置固化的布局(自动排列只在首次加载/新画板/点按钮时发生)、画板生命周期
// (懒挂载 / 自动测高 / 增量增删)、组件画板的底色档位
import type { RegistryEntry } from "../types.js"
import { boardUrl } from "./api.js"
import { clamp, frameDoc, h, qs } from "./dom.js"
import { setProbe } from "./hud.js"
import { attachFrameKeys } from "./modes.js"
import { renderBoardPins } from "./pins.js"
import { renderSidebar } from "./sidebar.js"
import { state, type Board } from "./state.js"
import { toast } from "./toast.js"
import { applyView } from "./view.js"

// 布局常量(世界坐标 px)。密度是"专业感"的第一来源:一个 56px 高的徽章原先要占
// 222px 竖向空间(利用率 25%),一屏 87% 是空的——这不是配色问题。
// ⚠️ TITLE_H 必须与 style.css 的 --cs-title-h 一致(.cs-pins/.cs-rz-e 的偏移都用它)
const PAD = 48
const BOARD_GAP = 24
const TITLE_H = 24
const SECTION_HEAD_H = 34
const SECTION_GAP = 40
/** 一行的软上限:即使没到 PER_ROW,太宽也换行,免得墙横向拉到天边 */
const ROW_MAX_W = 5200
const MIN_H = 88
const MAX_H = 1200
const DEFAULT_W = 480
/** 缩得比这更小就不再新挂 iframe:MIN_H 降低后一屏能塞下几十块,全挂会把 next dev 打爆 */
const MOUNT_MIN_SCALE = 0.35

let world: HTMLDivElement
let io: IntersectionObserver
const groups = new Map<string, { el: HTMLDivElement; titleEl: HTMLDivElement }>()
/** 自动测高次数上限,防止内容与容器互相追着改的死循环 */
const measureCount = new Map<string, number>()
const lastBodyH = new Map<string, number>()
/** 每块画板一个内容高观察者,iframe 重新导航时换掉旧的 */
const heightWatchers = new Map<string, ResizeObserver>()

export function initWall(): void {
  world = qs<HTMLDivElement>("#cs-world")
  initWallTools()
  io = new IntersectionObserver(
    (records) => {
      for (const r of records) {
        if (!r.isIntersecting) continue
        // 全景视角(缩得很小)时不挂载:此时看的是布局不是内容,而一次性挂几十个 iframe
        // 会把用户的 dev server 打爆。已挂的绝不卸载,放大回来时再补挂。
        if (state.scale < MOUNT_MIN_SCALE) continue
        const id = (r.target as HTMLElement).dataset.id
        const board = id ? state.boards.get(id) : null
        // 隐藏板不挂载:screen 默认收起就是为了省掉整页 iframe 的成本。
        // 也不能 unobserve —— 用户从侧栏打开时(hidden 摘掉),IO 会再报一次 intersecting,那时再挂
        if (board?.el.hidden) continue
        if (board) requestMount(board)
        io.unobserve(r.target)
      }
    },
    // 视口外 1.5 屏就开始挂
    { root: qs("#cs-viewport"), rootMargin: "150%" }
  )
}

// ---------- 增量同步 ----------

export function syncEntries(entries: RegistryEntry[]): void {
  state.entries = entries
  syncWallTools() // initWall 时 state.info 还没到位,这里补一次全局档位的高亮

  const byFile = new Map<string, RegistryEntry[]>()
  for (const e of entries) {
    const list = byFile.get(e.file)
    if (list) list.push(e)
    else byFile.set(e.file, [e])
  }

  // 消失的画板:摘掉
  const alive = new Set(entries.map((e) => e.id))
  for (const [id, board] of state.boards) {
    if (alive.has(id)) continue
    io.unobserve(board.el)
    board.el.remove()
    state.boards.delete(id)
    measureCount.delete(id)
    lastBodyH.delete(id)
    bgSyncs.delete(id)
    heightWatchers.get(id)?.disconnect()
    heightWatchers.delete(id)
  }
  const defaultHid = markSeenAndDefaultHide(entries)
  for (const [file, list] of byFile) {
    const ids = list.map((e) => e.id)
    // 位置稳定:已有 id 保持原顺序,新 id 追加到尾部
    const kept = (state.order.get(file) ?? []).filter((id) => ids.includes(id))
    state.order.set(file, kept.concat(ids.filter((id) => !kept.includes(id))))
    for (const entry of list) {
      const exist = state.boards.get(entry.id)
      if (exist) updateBoard(exist, entry)
      else state.boards.set(entry.id, createBoard(entry))
    }
  }
  // 文件没了就清掉它的顺序表
  for (const file of [...state.order.keys()]) if (!byFile.has(file)) state.order.delete(file)

  // 自动排列只在三种时机发生:① 这个项目第一次打开 ② 出现了没有位置的新画板
  // ③ 用户点「自动排列」。删画板、改尺寸、HMR 一律不重排 —— 用户摆好的墙不该被冲掉。
  if (firstSync && !hasAnyPos()) {
    autoArrange()
    // 画板刚建好时高度还是猜的(iframe 没挂),等首屏测完再铺一次,之后就彻底不动了
    settleDeadline = Date.now() + SETTLE_WINDOW
  } else {
    const n = placeNewBoards()
    applyPositions()
    if (n && !firstSync) toast(`新画板 ${n} 块 · 已放到墙底部`, "info")
  }
  // 用户加了 screens 一行却发现墙上没动静 —— 必须说清它去了哪
  if (defaultHid) toast("页面画板默认收起(整页 iframe 太重),在左侧「页面」分区按需打开", "info")
  if (state.boards.size) firstSync = false
  renderSidebar()
}

export function groupLabel(file: string): string {
  let s = file
  const dir = state.info?.designDir
  if (dir && s.startsWith(`${dir}/`)) s = s.slice(dir.length + 1)
  return s.replace(/\.artboard\.tsx?$/, "")
}

/** 分区标题(页面 / 组件),直接挂在世界坐标里 */
function ensureSection(key: "screen" | "component"): HTMLDivElement {
  const found = groups.get(key)
  if (found) return found.titleEl
  const titleEl = h("div", "cs-section-title")
  titleEl.dataset.section = key
  world.appendChild(titleEl)
  groups.set(key, { el: titleEl, titleEl })
  return titleEl
}

// ---------- 画板 ----------

function createBoard(entry: RegistryEntry): Board {
  const el = h("div", "cs-board")
  el.dataset.id = entry.id
  el.dataset.kind = entry.kind

  const titleEl = h("div", "cs-board-title")
  const nameEl = h("span", "cs-name", entry.exportName)
  const badgeEl = h("span", "cs-badge", entry.kind)
  badgeEl.dataset.kind = entry.kind
  const argsCountEl = h("span", "cs-args-n")
  titleEl.append(nameEl, badgeEl, argsCountEl)

  const frameEl = h("div", "cs-frame")
  const placeholderEl = h("div", "cs-ph", entry.exportName)
  const overlayEl = h("div", "cs-ovl")
  const pinLayerEl = h("div", "cs-pins")
  frameEl.append(placeholderEl, overlayEl)

  // pins 层不能进 frame:frame 有 overflow:hidden,pin 靠近画板顶部时
  // 向上弹的气泡会被裁掉。放 board 层、用 CSS 对齐到 frame 区域(标题条下方)。
  el.append(titleEl, frameEl, pinLayerEl)
  world.appendChild(el) // 画板直接活在世界坐标里,这样才好自由拖动

  const board: Board = {
    entry,
    el,
    titleEl,
    nameEl,
    badgeEl,
    argsCountEl,
    frameEl,
    overlayEl,
    pinLayerEl,
    placeholderEl,
    iframe: null,
    width: boardWidth(entry),
    // 高度优先级:手动拖过的 > 声明的 > 上次测出来缓存的 > 兜底 320。
    // 用缓存值开局,懒挂载的画板挂上来时高度就已经是对的,不会挂一块动一次墙。
    height: clamp(getSize(entry.id).h ?? entry.env?.height ?? getFit(entry.id).h ?? 320, MIN_H, MAX_DRAG_H),
    argsOverride: null,
  }
  // 控件放到标题条末尾。标题条现在按内容收缩,若把控件插在中间,标题条的几何中心
  // 就落在控件上——点"标题条中间"会被控件吃掉,args 面板永远打不开。
  if (entry.kind === "screen") titleEl.appendChild(widthSwitcher(board))
  if (entry.kind === "component") {
    titleEl.appendChild(bgToggle(board))
    board.el.dataset.bg = effectiveBg(entry.id) // iframe 挂上来之前,外层底色也得先对
  }
  attachResizeHandles(board)
  attachBoardDrag(board)
  el.hidden = isHidden(entry.id) // 出生即带显隐:IO 首帧回调抢在 applyPositions 前,晚了就白挂 iframe
  applySize(board)
  updateBoard(board, entry)
  io.observe(el)
  return board
}

// ---------- 每板的本机覆盖:尺寸(拖拽/切换器) + 底色开关 ----------

const WIDTH_PRESETS = [390, 768, 1024, 1280, 1440]
const MIN_SIZE = 120
const MAX_DRAG_H = 2400
/** screen 画板的宽度下拉,拖拽后要反向同步 */
const wsels = new Map<string, HTMLSelectElement>()

interface SizeOverride {
  w?: number
  h?: number
}

function sizeKey(id: string): string {
  return `cs-size:${state.info?.projectRoot ?? "unknown"}:${id}`
}

function getSize(id: string): SizeOverride {
  try {
    return (JSON.parse(localStorage.getItem(sizeKey(id)) ?? "{}") as SizeOverride) ?? {}
  } catch {
    return {}
  }
}

function setSize(id: string, patch: SizeOverride): void {
  try {
    localStorage.setItem(sizeKey(id), JSON.stringify({ ...getSize(id), ...patch }))
  } catch {
    /* 存不了就只影响本次 */
  }
}

function clearSize(id: string, dims: { w?: boolean; h?: boolean }): void {
  const cur = getSize(id)
  if (dims.w) delete cur.w
  if (dims.h) delete cur.h
  try {
    localStorage.setItem(sizeKey(id), JSON.stringify(cur))
  } catch {
    /* 同上 */
  }
}

/** 画板宽:本机覆盖(拖拽/切换器) > 声明的 env.width > 上次测出来的内容宽 > 默认 */
function boardWidth(entry: RegistryEntry): number {
  const o = getSize(entry.id).w
  if (typeof o === "number" && o >= MIN_SIZE) return o
  if (entry.env?.width) return entry.env.width
  return getFit(entry.id).w ?? DEFAULT_W
}

// ---------- 自动测量结果的缓存:位置固化之后,尺寸也得跨会话稳定 ----------
// 位置一旦固化,尺寸就不能每次刷新都从 320 重新长起来 —— 否则第一次测高就把
// 排好的墙撞乱。测出来的宽高按项目存本机,下次开局直接用,测量只是校正。

function fitKey(id: string): string {
  return `cs-fit:${state.info?.projectRoot ?? "unknown"}:${id}`
}

function getFit(id: string): SizeOverride {
  try {
    return (JSON.parse(localStorage.getItem(fitKey(id)) ?? "{}") as SizeOverride) ?? {}
  } catch {
    return {}
  }
}

function setFit(id: string, patch: SizeOverride): void {
  try {
    localStorage.setItem(fitKey(id), JSON.stringify({ ...getFit(id), ...patch }))
  } catch {
    /* 存不了就只影响本次 */
  }
}

// ---------- 手动位置 / 显隐(都按项目分键存本机) ----------

interface Pos {
  x: number
  y: number
}

function posKey(id: string): string {
  return `cs-pos:${state.info?.projectRoot ?? "unknown"}:${id}`
}

export function getPos(id: string): Pos | null {
  try {
    const raw = localStorage.getItem(posKey(id))
    if (!raw) return null
    const p = JSON.parse(raw) as Pos
    return Number.isFinite(p?.x) && Number.isFinite(p?.y) ? p : null
  } catch {
    return null
  }
}

function setPos(id: string, p: Pos): void {
  try {
    localStorage.setItem(posKey(id), JSON.stringify(p))
  } catch {
    /* 存不了就只影响本次 */
  }
}

/** 墙上有没有任何一块画板已经有位置(判断"这个项目是不是第一次打开") */
function hasAnyPos(): boolean {
  for (const id of state.boards.keys()) if (getPos(id)) return true
  return false
}

function hiddenKey(): string {
  return `cs-hidden:${state.info?.projectRoot ?? "unknown"}`
}

// ---------- screen 画板默认隐藏 ----------
// 一块 screen 画板 = 一个完整 app 实例的 iframe(React/provider/realtime 全套)。
// 二十几块同时挂载会把 dev server 和浏览器一起拖垮(Synco 实测翻车)。
// 所以 screen **首次出现时默认隐藏**,用户从侧栏按需打开;开/关的选择照常持久化。
// "首次"用 seen 集合判定:见过的 id 不再动它的显隐 —— 用户的选择永远优先。

function seenKey(): string {
  return `cs-seen:${state.info?.projectRoot ?? "unknown"}`
}

/** 把新出现的 id 记入 seen;其中 kind=screen 的顺手加进 hidden。返回是否有 screen 被默认隐藏 */
function markSeenAndDefaultHide(entries: RegistryEntry[]): boolean {
  let seen: Set<string>
  try {
    seen = new Set(JSON.parse(localStorage.getItem(seenKey()) ?? "[]") as string[])
  } catch {
    seen = new Set()
  }
  const fresh = entries.filter((e) => !seen.has(e.id))
  if (fresh.length === 0) return false
  const hid = hiddenSet()
  let hidSomething = false
  for (const e of fresh) {
    seen.add(e.id)
    if (e.kind === "screen") {
      hid.add(e.id)
      hidSomething = true
    }
  }
  try {
    localStorage.setItem(seenKey(), JSON.stringify([...seen]))
    if (hidSomething) localStorage.setItem(hiddenKey(), JSON.stringify([...hid]))
  } catch {
    /* 存不了就这一次生效 */
  }
  return hidSomething
}

function hiddenSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(hiddenKey()) ?? "[]") as string[])
  } catch {
    return new Set()
  }
}

export function isHidden(id: string): boolean {
  return hiddenSet().has(id)
}

export function toggleHidden(id: string): void {
  setHidden([id], !hiddenSet().has(id))
}

/** 批量显隐:侧栏的"一键显示/隐藏本组"走这条。逐条调 toggleHidden 会按条数重复整轮重排,
 *  几十块无感,上百块会明显卡 —— 这里落盘和重排各只做一次 */
export function setHidden(ids: string[], hidden: boolean): void {
  const s = hiddenSet()
  for (const id of ids) {
    if (hidden) s.add(id)
    else s.delete(id)
  }
  try {
    localStorage.setItem(hiddenKey(), JSON.stringify([...s]))
  } catch {
    /* 同上 */
  }
  cancelSettleArrange() // 用户开始操作墙了,首屏收尾重排到此为止
  placeNewBoards() // 亮回来的画板万一还没有位置(隐藏期间新增的),给它找一块空地
  applyPositions()
}

/** 标题条上的宽度下拉:切宽度不重载页面,响应式当场重排 */
function widthSwitcher(board: Board): HTMLSelectElement {
  const sel = document.createElement("select")
  sel.className = "cs-wsel"
  sel.title = "视口宽度:切换不重载,响应式当场重排;选过的记在本机"
  const declared = board.entry.env?.width
  const opts = [...new Set([...(declared ? [declared] : []), ...WIDTH_PRESETS])].sort((a, b) => a - b)
  for (const w of opts) {
    const o = document.createElement("option")
    o.value = String(w)
    o.textContent = `${w}${w === declared ? " (声明)" : ""}`
    sel.appendChild(o)
  }
  const custom = document.createElement("option")
  custom.value = "custom"
  custom.textContent = "自定义…"
  sel.appendChild(custom)
  sel.value = String(board.width)
  if (sel.value !== String(board.width)) {
    // 存的宽度不在预设里,补一个当前项
    const o = document.createElement("option")
    o.value = String(board.width)
    o.textContent = String(board.width)
    sel.insertBefore(o, custom)
    sel.value = String(board.width)
  }
  sel.addEventListener("click", (e) => e.stopPropagation()) // 别触发标题条的 args 面板
  sel.addEventListener("change", (e) => {
    e.stopPropagation()
    let w: number
    if (sel.value === "custom") {
      const input = prompt("视口宽度(px):", String(board.width))
      w = Number(input)
      if (!Number.isFinite(w) || w < MIN_SIZE) {
        sel.value = String(board.width)
        return
      }
    } else {
      w = Number(sel.value)
    }
    syncWsel(sel, w)
    board.width = w
    setSize(board.entry.id, { w })
    cancelSettleArrange()
    applySize(board)
    applyPositions() // 只有它自己变宽,邻居不动
  })
  wsels.set(board.entry.id, sel)
  return sel
}

/** 让下拉显示任意宽度值(不在预设里就补一项),拖拽后也走这里同步 */
function syncWsel(sel: HTMLSelectElement, w: number): void {
  if (![...sel.options].some((o) => o.value === String(w))) {
    const custom = [...sel.options].find((o) => o.value === "custom") ?? null
    const o = document.createElement("option")
    o.value = String(w)
    o.textContent = String(w)
    sel.insertBefore(o, custom)
  }
  sel.value = String(w)
}

/**
 * 拖标题条挪画板。每块画板的位置都是固化的,拖完只有它自己变 —— 邻居一个都不动、
 * 也不会有谁来"补位"。双击标题条空白处 = 把这一块放回自动排列会给它的位置。
 * 阈值 4px:小于这个距离当点击处理,免得"点标题条开 args 面板"变得难点中。
 */
function attachBoardDrag(board: Board): void {
  board.titleEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return
    cancelSettleArrange() // 用户开始摆墙了,首屏收尾重排立刻作废
    // 标题条上的控件(下拉/底色开关)自己处理事件,不要被拖拽劫持
    if ((e.target as Element).closest("select,button")) return
    const startX = e.clientX
    const startY = e.clientY
    const x0 = parseFloat(board.el.style.left || "0")
    const y0 = parseFloat(board.el.style.top || "0")
    let moved = false
    // 必须在 pointerdown 当场捕获:等移动了再捕获的话,鼠标早已离开这条 24px 高的标题条,
    // pointermove 根本收不到,拖拽会在第一像素就断掉。
    board.titleEl.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => {
      const dx = (ev.clientX - startX) / state.scale
      const dy = (ev.clientY - startY) / state.scale
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
      if (!moved) {
        moved = true
        board.el.classList.add("is-dragging")
      }
      board.el.style.left = `${Math.round(x0 + dx)}px`
      board.el.style.top = `${Math.round(y0 + dy)}px`
      setProbe(`${Math.round(x0 + dx)}, ${Math.round(y0 + dy)}`)
    }
    const up = (): void => {
      board.titleEl.removeEventListener("pointermove", move)
      board.titleEl.removeEventListener("pointerup", up)
      board.titleEl.releasePointerCapture?.(e.pointerId)
      if (!moved) return
      board.el.classList.remove("is-dragging")
      setPos(board.entry.id, {
        x: parseFloat(board.el.style.left || "0"),
        y: parseFloat(board.el.style.top || "0"),
      })
      applyPositions() // 只是把固化位置写回去 + 刷新分区标题,别人纹丝不动
      renderBoardPins(board)
    }
    board.titleEl.addEventListener("pointermove", move)
    board.titleEl.addEventListener("pointerup", up)
  })

  // 双击标题条:把这一块放回"自动排列会给它的位置"(只动它自己)
  board.titleEl.addEventListener("dblclick", (e) => {
    if ((e.target as Element).closest("select,button")) return
    e.stopPropagation()
    const p = computeAutoPositions().get(board.entry.id)
    if (!p) return
    setPos(board.entry.id, p)
    applyPositions()
    setProbe("已归位到自动排列的位置")
  })
}

// ---------- 拖拽调尺寸:右缘调宽、下缘调高、角上同时调 ----------

/** 拖拽中的画板 id:此时自动测高必须闭嘴,否则 ResizeObserver 会把拖到一半的高度当场弹回去 */
let resizing: string | null = null

function attachResizeHandles(board: Board): void {
  const mk = (cls: string, dw: boolean, dh: boolean): void => {
    const handle = h("div", `cs-rz ${cls}`)
    handle.title = "拖动调整 · 双击还原为声明/自动尺寸"
    handle.addEventListener("dblclick", (e) => {
      e.stopPropagation()
      cancelSettleArrange()
      clearSize(board.entry.id, { w: dw, h: dh })
      board.width = boardWidth(board.entry)
      const sel = wsels.get(board.entry.id)
      if (sel && dw) syncWsel(sel, board.width)
      measureBoard(board) // 高度回到声明值或自动测量
      applySize(board)
      applyPositions()
      setProbe("已还原尺寸")
    })
    handle.addEventListener("pointerdown", (e) => {
      e.stopPropagation()
      e.preventDefault()
      cancelSettleArrange()
      handle.setPointerCapture(e.pointerId)
      resizing = board.entry.id
      const startX = e.clientX
      const startY = e.clientY
      const w0 = board.width
      const h0 = board.frameEl.getBoundingClientRect().height / state.scale
      const move = (ev: PointerEvent): void => {
        // 屏幕位移换算回世界尺度
        if (dw) board.width = Math.round(clamp(w0 + (ev.clientX - startX) / state.scale, MIN_SIZE, MAX_DRAG_H))
        if (dh) board.height = Math.round(clamp(h0 + (ev.clientY - startY) / state.scale, MIN_SIZE, MAX_DRAG_H))
        applySize(board)
        setProbe(`${board.width} × ${Math.round(board.height)}`)
      }
      const up = (): void => {
        handle.removeEventListener("pointermove", move)
        handle.removeEventListener("pointerup", up)
        const patch: SizeOverride = {}
        if (dw) patch.w = board.width
        if (dh) patch.h = Math.round(board.height)
        setSize(board.entry.id, patch) // 先落盘,再放开测量 —— 顺序反了就会被自动测高覆盖
        resizing = null
        const sel = wsels.get(board.entry.id)
        if (sel && dw) syncWsel(sel, board.width)
        applyPositions() // 改的是自己的尺寸,邻居不该被推开
      }
      handle.addEventListener("pointermove", move)
      handle.addEventListener("pointerup", up)
    })
    board.el.appendChild(handle)
  }
  mk("cs-rz-e", true, false)
  mk("cs-rz-s", false, true)
  mk("cs-rz-se", true, true)
}

function updateBoard(board: Board, entry: RegistryEntry): void {
  const urlChanged = board.entry.kind !== entry.kind || board.entry.url !== entry.url
  board.entry = entry
  board.nameEl.textContent = entry.exportName
  board.nameEl.title = entry.exportName // 名字被裁时仍能读全
  board.badgeEl.textContent = entry.kind
  board.badgeEl.title = entry.kind === "screen" ? "页面画板" : "组件画板" // 徽标已缩成圆点
  board.badgeEl.dataset.kind = entry.kind
  board.el.dataset.kind = entry.kind
  // 页面画板显示它对应的真实路由 —— 光看 export 名不知道它是哪一页
  const n = entry.args ? Object.keys(entry.args).length : 0
  if (entry.kind === "screen" && entry.url) {
    board.argsCountEl.textContent = entry.url
    board.argsCountEl.classList.add("cs-route")
    board.argsCountEl.title = `路由 ${entry.url}`
  } else {
    board.argsCountEl.textContent = n ? `${n} args` : ""
    board.argsCountEl.classList.remove("cs-route")
    board.argsCountEl.title = ""
  }
  board.width = boardWidth(entry)
  if (entry.env?.height) board.height = clamp(entry.env.height, MIN_H, MAX_H)
  applySize(board)
  if (urlChanged && board.iframe) {
    const url = boardUrl(entry, board.argsOverride)
    board.iframe.dataset.csUrl = url
    board.iframe.src = url
  }
}

function applySize(board: Board): void {
  board.el.style.width = `${board.width}px`
  board.frameEl.style.width = `${board.width}px`
  board.frameEl.style.height = `${board.height}px`
  // 尺寸变了 = iframe 里的内容会重排 = pin 的锚点元素位置变了。
  // 不在这里重画的话,批注就会跟丢(切宽度、拖尺寸、自动测高之后都会发生)。
  schedulePinSync(board)
}

/** pin 重定位合并到下一帧:一次拖拽会触发几十次 applySize,不能每次都重画 */
const pinSyncPending = new Set<string>()
let pinSyncRaf = 0
function schedulePinSync(board: Board): void {
  pinSyncPending.add(board.entry.id)
  if (pinSyncRaf) return
  pinSyncRaf = requestAnimationFrame(() => {
    pinSyncRaf = 0
    for (const id of pinSyncPending) {
      const b = state.boards.get(id)
      if (b) renderBoardPins(b)
    }
    pinSyncPending.clear()
  })
}

/** 内容自己重排(HMR、异步渲染、交互展开菜单)时也要跟 —— 由 watchContentHeight 里的观察者调 */
export function syncPins(board: Board): void {
  schedulePinSync(board)
}

// 错峰挂载:同时加载的 iframe 封顶,其余排队 —— 刷新时十几块一起打 dev server 会让首屏更慢
const MAX_LOADING = 4
let loadingCount = 0
const mountQueue: Board[] = []

/** 从全景放大回来时补挂:IO 在低缩放下跳过的画板,此刻若可见就挂上 */
export function mountVisible(): void {
  if (state.scale < MOUNT_MIN_SCALE) return
  const vp = qs("#cs-viewport").getBoundingClientRect()
  for (const board of state.boards.values()) {
    if (board.iframe) continue
    const r = board.el.getBoundingClientRect()
    const visible = r.bottom > vp.top - vp.height && r.top < vp.bottom + vp.height &&
      r.right > vp.left - vp.width && r.left < vp.right + vp.width
    if (visible) requestMount(board)
  }
}

function requestMount(board: Board): void {
  if (board.el.hidden) return // 隐藏板永不挂载,打开时 IO/mountVisible 自然会再来
  if (board.iframe || mountQueue.includes(board)) return
  if (loadingCount >= MAX_LOADING) {
    mountQueue.push(board)
    return
  }
  mount(board)
}

function drainMountQueue(): void {
  while (loadingCount < MAX_LOADING && mountQueue.length) {
    const next = mountQueue.shift()
    if (next && !next.iframe) mount(next)
  }
}

function mount(board: Board): void {
  if (board.iframe) return
  loadingCount++
  const iframe = document.createElement("iframe")
  iframe.title = board.entry.exportName
  const url = boardUrl(board.entry, board.argsOverride)
  iframe.dataset.csUrl = url
  let settled = false
  const settle = (): void => {
    if (settled) return
    settled = true
    loadingCount = Math.max(0, loadingCount - 1)
    drainMountQueue()
  }
  iframe.addEventListener("load", () => {
    settle()
    onFrameLoad(board)
  })
  setTimeout(settle, 10000) // load 事件万一不来,别把队伍堵死
  board.frameEl.insertBefore(iframe, board.overlayEl)
  iframe.src = url
  board.iframe = iframe
  board.placeholderEl.hidden = true
}

function onFrameLoad(board: Board): void {
  const doc = frameDoc(board.iframe)
  if (!doc) return
  attachFrameKeys(doc)
  injectWallCss(board)
  measureBoard(board)
  applyPositions() // 测出来的高只改自己这一块,不重排别人
  scheduleSettleArrange() // 只在首屏那几秒有效,之后是空操作
  renderBoardPins(board)
  watchContentHeight(board)
}

/** 墙的语境样式注入(同源才可能):藏 Next dev indicator;组件画板的底色另走 applyBgPref */
function injectWallCss(board: Board): void {
  const doc = frameDoc(board.iframe)
  if (!doc?.head) return
  if (!doc.getElementById("__cs_wall_css")) {
    const st = doc.createElement("style")
    st.id = "__cs_wall_css"
    // dev indicator 的 N,墙上纯噪音(要看错误浮层去 :3000)
    st.textContent = "nextjs-portal{display:none !important}"
    doc.head.appendChild(st)
  }
  applyBgPref(board)
}

// ---------- 组件画板的底色:融入画布 / 项目真实底色 ----------
//
// iframe 的画布底在浏览器里必然不透明:把嵌入文档的 html/body 设成 background:transparent,
// 计算值确实是透明,渲染出来仍然是白。所以"让它真透明"这条路走不通,只有两档可选:
//   blend「融入画布」(默认):把画布底刷成画布同色(--cs-bg),那块白就在墙里消失了;
//   real 「项目真实底色」:刷成项目自己的 --background,看组件在真实页面底色上的样子。
// 页面(screen)画板不参与 —— 它本来就该显示真实页面。

type BgMode = "blend" | "real"

/** 出厂默认必须是不显眼的那档 */
const BG_FALLBACK: BgMode = "blend"
const BG_LABEL: Record<BgMode, string> = { blend: "融入画布", real: "项目真实底色" }

/** 全局默认档(墙层面,按项目存本机) */
function bgGlobalKey(): string {
  return `cs-bg-default:${state.info?.projectRoot ?? "unknown"}`
}

function globalBg(): BgMode {
  try {
    return localStorage.getItem(bgGlobalKey()) === "real" ? "real" : BG_FALLBACK
  } catch {
    return BG_FALLBACK
  }
}

function setGlobalBg(mode: BgMode): void {
  try {
    localStorage.setItem(bgGlobalKey(), mode)
  } catch {
    /* 存不了就只影响本次 */
  }
}

/** 每板覆盖(按项目 + 画板存本机);没有这个键 = 跟随全局 */
function bgKey(id: string): string {
  return `cs-bg:${state.info?.projectRoot ?? "unknown"}:${id}`
}

function bgOverride(id: string): BgMode | null {
  try {
    const v = localStorage.getItem(bgKey(id))
    if (v === "blend") return "blend"
    if (v === "real" || v === "1") return "real" // "1" 是老版本的"显示项目底色"
    return null
  } catch {
    return null
  }
}

function setBgOverride(id: string, mode: BgMode | null): void {
  try {
    if (mode) localStorage.setItem(bgKey(id), mode)
    else localStorage.removeItem(bgKey(id))
  } catch {
    /* 同上 */
  }
}

function effectiveBg(id: string): BgMode {
  return bgOverride(id) ?? globalBg()
}

/**
 * 画布自己的底色。注入进 iframe 的是**色值**(iframe 里没有画布的 CSS 变量),
 * 所以这里现读 --cs-bg,换主题自动跟随;末尾那个字面量只是变量读不到时的兜底,
 * 不是第二个色源。
 */
function canvasBg(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--cs-bg").trim() || "#0a0b0d"
}

/** 把某块组件画板的底色档位落到外层 DOM + iframe 里 */
function applyBgPref(board: Board): void {
  if (board.entry.kind !== "component") return
  const mode = effectiveBg(board.entry.id)
  board.el.dataset.bg = mode // .cs-frame 的底/描边跟着这个属性走(见 style-wall.css)
  const doc = frameDoc(board.iframe)
  if (!doc?.head) return
  let st = doc.getElementById("__cs_bg") as HTMLStyleElement | null
  if (!st) {
    st = doc.createElement("style")
    st.id = "__cs_bg"
    doc.head.appendChild(st)
  }
  // 刷 html,body 而不是 wrapper:画布底是从 html/body 传播上去的,
  // 只给 wrapper 上色的话 padding 之外仍是一圈白边
  // 顺带隐掉根滚动条:画板高度本来就自动贴内容,测高的半路上冒出来的滚动条只是噪音,
  // 白色轨道压在暗画布上尤其扎眼。只隐 html/body 这一层,组件内部的滚动区是它自己的真实样子,不动。
  const noScrollbar =
    "html{scrollbar-width:none}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none}"
  st.textContent =
    (mode === "blend"
      ? `html,body{background:${canvasBg()} !important}`
      : "html,body{background:var(--background,#fff) !important}") + noScrollbar
}

/** 每块画板的底色按钮要跟着全局档位改字形,存下各自的同步函数 */
const bgSyncs = new Map<string, () => void>()

/**
 * 标题条上的底色开关(组件画板专用)。三态,但顺序保证"每次点击都看得见变化":
 * 跟随全局 → 与全局相反(本板覆盖) → 与全局相同(本板覆盖) → 回到跟随全局。
 */
function bgToggle(board: Board): HTMLButtonElement {
  const id = board.entry.id
  const btn = document.createElement("button")
  btn.className = "cs-bgbtn"
  const sync = (): void => {
    const ov = bgOverride(id)
    const eff = ov ?? globalBg()
    btn.textContent = eff === "blend" ? "◻" : "▣"
    btn.classList.toggle("is-on", eff === "real")
    btn.classList.toggle("is-auto", ov === null)
    btn.title = `底色:${BG_LABEL[eff]}(${ov ? "本板覆盖" : "跟随全局"}) · 点击切换`
    btn.setAttribute("aria-label", btn.title)
  }
  sync()
  bgSyncs.set(id, sync)
  btn.addEventListener("click", (e) => {
    e.stopPropagation()
    const ov = bgOverride(id)
    const g = globalBg()
    setBgOverride(id, ov === null ? (g === "blend" ? "real" : "blend") : ov === g ? null : g)
    sync()
    applyBgPref(board)
  })
  return btn
}

// ---------- 墙层面的工具条(JS 建元素,不动 index.html) ----------

const segBtns: Array<{ el: HTMLButtonElement; mode: BgMode }> = []

/** 右上角小条:全局底色默认档 + 自动排列。这两件事都是整面墙的,塞不进单块画板的标题条 */
function initWallTools(): void {
  const bar = h("div", "cs-wall-tools")
  bar.id = "cs-wall-tools"

  const label = h("span", "cs-wt-label", "组件底色")
  label.title = "组件画板的默认底色(按项目记在本机)。单块画板可以用标题条上的 ◻/▣ 单独覆盖"
  const seg = h("div", "cs-seg")
  for (const mode of ["blend", "real"] as const) {
    const b = h("button", "cs-seg-btn", mode === "blend" ? "融入画布" : "项目底色")
    b.title =
      mode === "blend"
        ? "所有组件画板默认把底色刷成画布同色 —— 白底不再抢镜"
        : "所有组件画板默认显示项目自己的 --background"
    b.addEventListener("click", () => {
      setGlobalBg(mode)
      syncWallTools()
      for (const board of state.boards.values()) {
        applyBgPref(board) // 有本板覆盖的自己说了算,不受影响
        bgSyncs.get(board.entry.id)?.()
      }
    })
    seg.appendChild(b)
    segBtns.push({ el: b, mode })
  }

  const arrange = h("button", "cs-wt-btn", "自动排列")
  arrange.title = "把所有画板重新铺开(页面 4/行、组件 15/行)。平时不会自动重排 —— 你摆好的位置一直留着"
  arrange.addEventListener("click", () => {
    cancelSettleArrange()
    toast(`已重新排列 ${autoArrange()} 块画板`, "ok")
  })

  bar.append(label, seg, arrange)
  document.body.appendChild(bar)
  syncWallTools()
}

function syncWallTools(): void {
  const g = globalBg()
  for (const s of segBtns) {
    s.el.classList.toggle("is-on", s.mode === g)
    s.el.setAttribute("aria-pressed", String(s.mode === g))
  }
}

/** 内容自己变高变矮(HMR、异步渲染)时跟着测一次 */
function watchContentHeight(board: Board): void {
  heightWatchers.get(board.entry.id)?.disconnect()
  const doc = frameDoc(board.iframe)
  const body = doc?.body
  if (!body || typeof ResizeObserver === "undefined") return
  const ro = new ResizeObserver(() => {
    const cur = body.getBoundingClientRect().height
    const prev = lastBodyH.get(board.entry.id) ?? -1
    // 内容重排但总高没变(横向重排、展开同高的菜单)也要让 pin 跟上
    schedulePinSync(board)
    if (Math.abs(cur - prev) < 2) return
    lastBodyH.set(board.entry.id, cur)
    const times = (measureCount.get(board.entry.id) ?? 0) + 1
    measureCount.set(board.entry.id, times)
    if (times > 30) {
      ro.disconnect() // 兜底:别让内容和容器互相追高
      return
    }
    measureBoard(board)
    applyPositions() // 内容长高只影响它自己,不推开邻居(要重铺请点「自动排列」)
    scheduleSettleArrange()
  })
  ro.observe(body)
  heightWatchers.set(board.entry.id, ro)
}

/**
 * 测内容高:env.height 优先;否则先把 iframe 压到最小再读 scrollHeight
 * (不压的话 scrollHeight 会被 iframe 自身高度撑住,只涨不落)
 */
export function measureBoard(board: Board): void {
  if (resizing === board.entry.id) return // 拖拽中,别跟手较劲
  // 手动拖过的尺寸优先于一切自动测量
  const manual = getSize(board.entry.id)
  if (manual.h) {
    board.height = clamp(manual.h, MIN_SIZE, MAX_DRAG_H)
    applySize(board)
    return
  }
  const fixed = board.entry.env?.height
  if (fixed) {
    board.height = clamp(fixed, MIN_H, MAX_H)
    applySize(board)
    return
  }
  const iframe = board.iframe
  const doc = frameDoc(iframe)
  if (!iframe || !doc?.documentElement) return
  const prev = iframe.style.height
  iframe.style.height = `${MIN_H}px`
  const raw = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0)
  iframe.style.height = prev
  board.height = clamp(raw, MIN_H, MAX_H)
  lastBodyH.set(board.entry.id, doc.body?.getBoundingClientRect().height ?? -1)
  setFit(board.entry.id, { h: Math.round(board.height) }) // 缓存给下次开局用
  // 没声明 env.width 且没手动拖过的组件画板:iframe 宽收缩到内容实际宽(模板已给 wrapper fit-content)
  if (board.entry.kind === "component" && !board.entry.env?.width && !manual.w) {
    const ab = doc.querySelector("[data-cs-artboard]")
    if (ab) {
      const w = Math.ceil(ab.getBoundingClientRect().width)
      if (w > 0) {
        board.width = clamp(w, 120, DEFAULT_W)
        setFit(board.entry.id, { w: board.width })
      }
    }
  }
  applySize(board)
}

/** SSE registry 事件之后重测所有已挂载画板(只更新尺寸,位置不动) */
export function remeasureAll(): void {
  for (const board of state.boards.values()) {
    measureCount.set(board.entry.id, 0)
    if (board.iframe) measureBoard(board)
  }
  applyPositions()
}

// ---------- 布局 ----------
//
// 每块画板的位置都是"固化"的(存本机),墙平时只是把它们照着坐标摆好。
// 自动排列(全量重算 + 覆写坐标)只在三种时机发生:
//   ① 这个项目第一次打开(本机一个坐标都没有);
//   ② 出现了还没有坐标的新画板 —— 只给新的找空位,已有的一块都不动;
//   ③ 用户点「自动排列」。
// 拖动结束、改尺寸、内容测高、HMR、删画板都不重排。

/** 每行最多几块:页面很宽所以一行 4 块,组件很小所以一行 15 块 */
const PER_ROW = { screen: 4, component: 15 }

/** 参与排列的画板:按文件名字典序 + 文件内 export 顺序,隐藏的不占格子 */
function arrangeable(): Board[] {
  const out: Board[] = []
  for (const file of [...state.order.keys()].sort()) {
    for (const id of state.order.get(file) ?? []) {
      const b = state.boards.get(id)
      if (b && !isHidden(id)) out.push(b)
    }
  }
  return out
}

/** 逐行铺:攒够 PER_ROW 或宽度超过软上限就换行,行高取该行最高的。返回下一行的 y */
function flowRows(list: Board[], kind: "screen" | "component", startY: number, out: Map<string, Pos>): number {
  let y = startY
  let row: Board[] = []
  let rowW = 0
  const flush = (): void => {
    if (!row.length) return
    let x = PAD
    const rowH = Math.max(...row.map((b) => TITLE_H + b.height))
    for (const b of row) {
      out.set(b.entry.id, { x, y })
      x += b.width + BOARD_GAP
    }
    y += rowH + BOARD_GAP
    row = []
    rowW = 0
  }
  for (const b of list) {
    if (row.length >= PER_ROW[kind] || (row.length && rowW + b.width > ROW_MAX_W)) flush()
    row.push(b)
    rowW += b.width + BOARD_GAP
  }
  flush()
  return y
}

/** 算一遍"自动排列会把每块放在哪"(纯计算,不碰 DOM):按 kind 分区、页面在上组件在下 */
function computeAutoPositions(): Map<string, Pos> {
  const out = new Map<string, Pos>()
  const ordered = arrangeable()
  let y = PAD
  for (const kind of ["screen", "component"] as const) {
    const list = ordered.filter((b) => b.entry.kind === kind)
    if (!list.length) continue
    y += SECTION_HEAD_H // 给分区标题留一行(标题坐标由 layoutSections 从画板反推)
    y = flowRows(list, kind, y, out)
    y += SECTION_GAP
  }
  return out
}

/** 全量重算并固化坐标 —— 只有首次加载与用户点「自动排列」会走到这。返回排了几块 */
export function autoArrange(): number {
  const pos = computeAutoPositions()
  for (const [id, p] of pos) setPos(id, p)
  applyPositions()
  return pos.size
}

/**
 * 只给"还没有坐标"的画板找地方:铺在现有内容的下沿之外,已有画板一块都不动。
 * 返回新放置的块数。
 */
function placeNewBoards(): number {
  const ordered = arrangeable()
  const fresh = ordered.filter((b) => !getPos(b.entry.id))
  if (!fresh.length) return 0
  let bottom = -Infinity
  for (const b of ordered) {
    const p = getPos(b.entry.id)
    if (p) bottom = Math.max(bottom, p.y + TITLE_H + b.height)
  }
  let y = Number.isFinite(bottom) ? bottom + SECTION_GAP : PAD
  const out = new Map<string, Pos>()
  for (const kind of ["screen", "component"] as const) {
    const list = fresh.filter((b) => b.entry.kind === kind)
    if (!list.length) continue
    y = flowRows(list, kind, y, out) + SECTION_GAP
  }
  for (const [id, p] of out) setPos(id, p)
  return out.size
}

/**
 * 轻量:把固化的坐标写回 DOM。不改任何画板的位置 —— 拖动结束、改尺寸、内容测高、
 * SSE 刷新走的都是它,所以用户摆好的墙不会被冲掉。
 */
export function applyPositions(): void {
  for (const b of state.boards.values()) {
    const p = getPos(b.entry.id)
    if (p) {
      b.el.style.left = `${p.x}px`
      b.el.style.top = `${p.y}px`
    }
    // 隐藏的画板从墙上撤下(但仍在 state 里,侧栏能勾回来)
    b.el.hidden = isHidden(b.entry.id)
  }
  layoutSections()
  // 必须保留:select.ts 的高亮框/标签只在 applyView 的监听里重算,摘掉这行框就会落后一帧到停
  applyView()
}

/** 分区标题贴在本区画板包围盒的左上角:它跟着画板走,自己不占布局 */
function layoutSections(): void {
  for (const kind of ["screen", "component"] as const) {
    const titleEl = ensureSection(kind)
    let minX = Infinity
    let minY = Infinity
    let n = 0
    for (const b of state.boards.values()) {
      if (b.entry.kind !== kind || isHidden(b.entry.id)) continue
      n++
      const p = getPos(b.entry.id)
      if (!p) continue
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
    }
    if (!n || !Number.isFinite(minX)) {
      titleEl.hidden = true
      continue
    }
    titleEl.hidden = false
    titleEl.textContent = ""
    titleEl.append(
      h("span", undefined, kind === "screen" ? "页面" : "组件"),
      h("span", "cs-section-count", String(n))
    )
    titleEl.style.left = `${minX}px`
    titleEl.style.top = `${minY - SECTION_HEAD_H}px`
  }
}

// ---------- 首屏收尾重排 ----------
//
// 画板刚建好时高度是猜的(iframe 还没挂),首次加载那一铺必然不准。
// 所以只在开局的几秒里,等测高落定后再铺一次;用户一动手(拖/改尺寸/显隐)立刻作废,
// 之后墙就彻底不再自动重排了。

const SETTLE_WINDOW = 8000
let firstSync = true
let settleDeadline = 0
let settleTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSettleArrange(): void {
  if (!settleDeadline || Date.now() > settleDeadline) return
  if (settleTimer !== null) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    settleTimer = null
    if (!settleDeadline) return
    autoArrange()
  }, 350)
}

function cancelSettleArrange(): void {
  settleDeadline = 0
  if (settleTimer !== null) clearTimeout(settleTimer)
  settleTimer = null
}
