// 三模式(浏览/交互/走查)+ overlay 事件反查 + 快捷键
import { postSelection } from "./api.js"
import { clamp, qs } from "./dom.js"
import { setProbe, syncHud } from "./hud.js"
import { closeArgsPanel, isArgsOpen, openArgsPanel } from "./args-panel.js"
import {
  closeComposer, copyContext, deleteSelectedPin, editSelectedPin, enterPinMode, exitPinMode,
  isComposing, openComposer, pushToClaudeCode, selectPin, selectedPin,
} from "./pins.js"
import {
  buildSelector,
  clearSelection,
  describe,
  elementAt,
  hideHover,
  relPos,
  showHover,
  showSelection,
} from "./select.js"
import { state, type Board, type Mode } from "./state.js"
import { toast } from "./toast.js"
import { setHidden } from "./wall.js"
import {
  MAX_SCALE, MIN_SCALE, applyView, fitAll, fitBoard, isPanning, setView, zoomReset, zoomStep,
} from "./view.js"

let viewport: HTMLDivElement

function boardOf(target: EventTarget | null): Board | null {
  const el = (target as Element | null)?.closest?.(".cs-board") as HTMLElement | null
  if (!el?.dataset.id) return null
  return state.boards.get(el.dataset.id) ?? null
}

export function setActive(id: string | null): void {
  if (state.activeId === id) return
  state.activeId = id
  for (const b of state.boards.values()) b.el.classList.toggle("is-active", b.entry.id === id)
}

export function setMode(mode: Mode, boardId?: string): void {
  if (mode !== "browse" && boardId) setActive(boardId)
  if (mode === "review" && !state.activeId) return
  const from = state.mode
  state.mode = mode
  hideHover()
  // 交互/走查模式下,可交互的是整块画板,元素级的选中框会让人以为"只有这个元素能点"。
  // 收掉框,改由画板整体的高亮边框表达范围 —— 交互范围 = 高亮范围。
  if (mode !== "browse") clearSelection()
  syncHud()

  if (mode === "review" && from !== "review") {
    state.modeBeforeReview = from
    state.viewBeforeReview = { scale: state.scale, tx: state.tx, ty: state.ty }
    closeArgsPanel() // 走查要的是全宽,别让 args 面板压住宽画板
    fitActiveBoard()
  } else if (mode !== "review" && from === "review" && state.viewBeforeReview) {
    const v = state.viewBeforeReview
    state.viewBeforeReview = null
    setView(v.tx, v.ty, v.scale)
  }
  setProbe(
    mode === "interact"
      ? "交互模式:直接操作这块画板,Esc 回浏览"
      : mode === "review"
        ? "走查模式:Esc 退出"
        : "移到画板上反查元素"
  )
}

/** 走查:把当前画板缩放平移到铺满视口(不搬 DOM,iframe 不会重载) */
function fitActiveBoard(): void {
  const board = state.activeId ? state.boards.get(state.activeId) : null
  if (!board) return
  // data-mode 已切到 review(标题条已隐藏),此刻读到的才是最终位置
  const r = board.frameEl.getBoundingClientRect()
  const worldX = (r.left - state.tx) / state.scale
  const worldY = (r.top - state.ty) / state.scale
  const vw = window.innerWidth
  const vh = window.innerHeight
  const s = clamp(Math.min(vw / board.width, vh / board.height), MIN_SCALE, MAX_SCALE)
  setView((vw - board.width * s) / 2 - worldX * s, (vh - board.height * s) / 2 - worldY * s, s)
}

/** Esc 逐级退出:批注 → 走查 → 交互 → 清选中 */
function escape(): void {
  if (isComposing()) {
    closeComposer()
    exitPinMode()
    return
  }
  if (state.pinPending) {
    exitPinMode()
    return
  }
  if (selectedPin()) {
    selectPin(null)
    return
  }
  if (state.mode === "review") {
    setMode(state.modeBeforeReview === "review" ? "browse" : state.modeBeforeReview)
    return
  }
  if (state.mode === "interact") {
    setMode("browse")
    return
  }
  clearSelection()
  closeArgsPanel()
  setProbe("移到画板上反查元素")
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true) return true
  // chrome 层(侧栏/args 面板/选择器)里的控件自己就要用 Enter/Space/Backspace。
  // 只按标签名判断的话,焦点一落到侧栏的折叠按钮上,按 Enter 就被"走查"吃掉,按钮永远按不下去。
  return el.closest("#cs-sidebar, #cs-args, .cs-picker, #cs-topbar") !== null
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    escape()
    return
  }
  if (isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === "Enter") {
    // 选中了 pin 就先服务它:Enter 进编辑,编辑中 Enter 保存
    if (selectedPin()) {
      e.preventDefault()
      editSelectedPin()
      return
    }
    if (state.mode !== "review" && state.activeId) {
      e.preventDefault()
      setMode("review", state.activeId)
    }
    return
  }
  if (e.key === "Backspace" || e.key === "Delete") {
    if (selectedPin()) {
      e.preventDefault()
      deleteSelectedPin()
      return
    }
    // 浏览模式下对着画板按 Backspace = 收起它(不是删除 —— 侧栏随时点回来)。
    // 只在浏览模式生效:交互/走查中按退格多半是想改 iframe 里的文字,不能把整块板收走
    if (state.mode === "browse" && state.activeId) {
      e.preventDefault()
      const b = state.boards.get(state.activeId)
      setHidden([state.activeId], true)
      clearSelection()
      setActive(null)
      toast(`已收起「${b?.entry.exportName ?? state.activeId}」· 左侧列表随时点回来`, "info")
    }
    return
  }
  if (e.key === "c" || e.key === "C") {
    if (state.mode === "browse" && !state.pinPending) {
      e.preventDefault()
      enterPinMode()
    }
    return
  }
  if (e.key === "y" || e.key === "Y") {
    e.preventDefault()
    void copyContext()
    return
  }
  if (e.key === "p") {
    e.preventDefault()
    void pushToClaudeCode() // 多候选时每次都弹选择器,没有"记住的会话"这回事
    return
  }
  // 视图导航:一整面墙没有"看全"的手段是最要命的缺失
  if (e.key === "1") {
    e.preventDefault()
    fitAll()
    return
  }
  if (e.key === "2") {
    e.preventDefault()
    fitBoard()
    return
  }
  if (e.key === "0") {
    e.preventDefault()
    zoomReset()
    return
  }
  if (e.key === "=" || e.key === "+") {
    e.preventDefault()
    zoomStep(1.25)
    return
  }
  if (e.key === "-" || e.key === "_") {
    e.preventDefault()
    zoomStep(0.8)
  }
}

/** 同源 iframe 里的按键也要能触发外壳快捷键(交互/走查模式下焦点在 iframe 内) */
export function attachFrameKeys(doc: Document): void {
  doc.addEventListener("keydown", onKeyDown)
}

// ---------- overlay 事件 ----------

function onMouseMove(e: MouseEvent): void {
  if (isPanning()) return
  const overlay = (e.target as Element | null)?.closest?.(".cs-ovl")
  const board = overlay ? boardOf(e.target) : null
  if (!board) {
    hideHover() // 移出画板到空白处,别把描边框留在原地
    return
  }
  // 只有浏览模式跟着鼠标换活动画板:交互/走查模式的目标必须钉住
  if (state.mode !== "browse") return
  setActive(board.entry.id)
  const el = elementAt(board, e.clientX, e.clientY)
  if (!el) {
    hideHover()
    return
  }
  showHover(board, el)
  setProbe(`${board.entry.exportName}  ${describe(el)}`)
}

function onClick(e: MouseEvent): void {
  const target = e.target as Element | null

  // 标题条:开/关 args 面板
  const title = target?.closest?.(".cs-board-title")
  if (title) {
    const board = boardOf(target)
    if (!board) return
    setActive(board.entry.id)
    if (isArgsOpen(board.entry.id)) closeArgsPanel()
    else openArgsPanel(board)
    return
  }

  const overlay = target?.closest?.(".cs-ovl")
  if (!overlay) return
  const board = boardOf(target)
  if (!board) return
  if (state.mode === "interact") {
    // 不抢焦点是故意的(误触不该打断正在交互的板),但零反馈会让人以为"交互模式坏了":
    // 压暗的板点不动 + 没有任何提示 = "我进入了交互模式但是不可以交互"
    if (board.entry.id !== state.activeId) hintInactive(board)
    return
  }
  setActive(board.entry.id)

  const el = elementAt(board, e.clientX, e.clientY)
  if (!el) return

  if (state.pinPending) {
    openComposer(board, el, e.clientX, e.clientY)
    return
  }
  if (state.mode !== "browse") return

  const selector = buildSelector(el)
  const rel = relPos(el, e.clientX, e.clientY, board)
  showSelection(board, selector)
  state.selection = { artboardId: board.entry.id, selector, x: rel.x, y: rel.y, ts: Date.now() }
  setProbe(`已选中 ${board.entry.exportName} → ${selector}`)
  postSelection(state.selection).catch((err) => setProbe(`selection 发送失败:${String(err)}`))
}

let lastHint = ""
let lastHintAt = 0
function hintInactive(board: Board): void {
  const cur = state.boards.get(state.activeId ?? "")?.entry.exportName ?? "?"
  setProbe(`交互中的是「${cur}」—— 要交互这块请双击它,Esc 退出交互`)
  const now = Date.now()
  if (lastHint === board.entry.id && now - lastHintAt < 4000) return
  lastHint = board.entry.id
  lastHintAt = now
  toast(`「${board.entry.exportName}」未激活 · 双击它切换交互目标`, "info")
}

function onDblClick(e: MouseEvent): void {
  const board = boardOf(e.target)
  if (!board || !(e.target as Element).closest(".cs-ovl")) return
  setMode("interact", board.entry.id)
}

export function initModes(): void {
  // 挂在视口上(不是世界容器):鼠标移到空白处也要收到事件,才好把描边框收掉
  viewport = qs<HTMLDivElement>("#cs-viewport")
  viewport.addEventListener("mousemove", onMouseMove)
  viewport.addEventListener("mouseleave", hideHover)
  viewport.addEventListener("click", onClick)
  viewport.addEventListener("dblclick", onDblClick)
  document.addEventListener("keydown", onKeyDown)
  window.addEventListener("resize", () => {
    if (state.mode === "review") fitActiveBoard()
    else applyView()
  })
  syncHud()
}
