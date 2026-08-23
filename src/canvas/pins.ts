// pin 批注:画点、hover 气泡、就地输入框
import type { Annotation } from "../types.js"
import { createAnnotation, deleteAnnotation, fetchContext, patchAnnotation, pushContext } from "./api.js"
import { frameDoc, h, qs } from "./dom.js"
import { setProbe, syncHud } from "./hud.js"
import { UPLOADING, attachInline, refThumb, removeRefToken, setPasteTarget, uploadRef } from "./refs.js"
import { toast } from "./toast.js"
import { buildSelector, relPos } from "./select.js"
import { state, type Board } from "./state.js"

let fx: HTMLDivElement
let composer: HTMLDivElement | null = null

export function initPins(): void {
  fx = qs<HTMLDivElement>("#cs-fx")
}

/** 重画所有画板的 pin */
export function renderPins(): void {
  for (const board of state.boards.values()) renderBoardPins(board)
}

export function renderBoardPins(board: Board): void {
  const layer = board.pinLayerEl
  layer.textContent = ""
  const doc = frameDoc(board.iframe)
  // verified = 人工核验完毕,从墙上消失(但留在 annotations.json 里当历史)
  const list = state.annotations.filter(
    (a) => a.artboardId === board.entry.id && a.status !== "verified"
  )
  const used = new Map<string, number>() // 同锚点的多条批注横向错开,否则下面那条永远点不到
  list.forEach((ann, i) => {
    let left = 8
    let top = 8
    let orphan = true
    if (doc && ann.anchor) {
      let el: Element | null = null
      try {
        el = doc.querySelector(ann.anchor.selector)
      } catch {
        el = null
      }
      if (el) {
        const r = el.getBoundingClientRect()
        left = r.left + ann.anchor.x * r.width
        top = r.top + ann.anchor.y * r.height
        orphan = false
      }
    }
    // 12px 网格聚类:同点或近重叠(差几个像素)的 pin 都要错开,否则下面那颗点不到
    const key = `${Math.round(left / 12)}:${Math.round(top / 12)}`
    const dup = used.get(key) ?? 0
    used.set(key, dup + 1)
    left += dup * 20

    // 显示永久序号,不是"本板第几个":两块板各自从 1 数会出现好几个"1",
    // 而且前面的批注被核验后,后面的号全体前移 —— 跟 Claude 对话时指认不了同一条
    const pin = h("div", "cs-pin", String(ann.seq ?? i + 1))
    pin.dataset.annId = ann.id
    if (ann.status === "resolved") pin.classList.add("is-resolved")
    if (ann.id === selectedPinId) pin.classList.add("is-selected")
    if (orphan) {
      pin.classList.add("is-orphan")
      pin.title = "锚点元素没找到,pin 落在画板左上角"
    }
    pin.style.left = `${left}px`
    pin.style.top = `${top}px`
    // 点 pin = 选中它,之后 Enter 编辑 / Backspace 删除
    pin.addEventListener("click", (e) => {
      e.stopPropagation()
      selectPin(ann.id)
    })
    pin.appendChild(bubble(ann))
    attachHoverGrace(pin)
    layer.appendChild(pin)
  })
}

// ---------- pin 选中 + 键盘操作 ----------

let selectedPinId: string | null = null

export function selectedPin(): string | null {
  return selectedPinId
}

export function selectPin(id: string | null): void {
  selectedPinId = id
  for (const p of document.querySelectorAll<HTMLElement>(".cs-pin")) {
    p.classList.toggle("is-selected", !!id && p.dataset.annId === id)
    if (id && p.dataset.annId === id) p.classList.add("is-open") // 选中就把气泡留住
    else p.classList.remove("is-open")
  }
  setProbe(id ? "批注已选中:Enter 编辑 · Backspace 删除 · Esc 取消" : "移到画板上反查元素")
}

/** Enter:没在编辑就进编辑,正在编辑就保存 */
export function editSelectedPin(): void {
  if (!selectedPinId) return
  const pin = document.querySelector<HTMLElement>(`.cs-pin[data-ann-id="${CSS.escape(selectedPinId)}"]`)
  if (!pin) return
  const box = pin.querySelector<HTMLElement>(".cs-pin-bubble")
  if (!box) return
  const saveBtn = [...box.querySelectorAll("button")].find((b) => b.textContent === "保存")
  if (saveBtn) {
    saveBtn.click() // 编辑中 → 保存
    return
  }
  const ann = state.annotations.find((a) => a.id === selectedPinId)
  const textEl = box.querySelector<HTMLElement>(".cs-pin-text")
  if (ann && textEl) startEdit(box, textEl, ann)
}

export function deleteSelectedPin(): void {
  if (!selectedPinId) return
  const id = selectedPinId
  selectedPinId = null
  void remove(id)
}

/** hover 开合走 JS + 250ms 关闭宽限。
 *  pin 与气泡之间那条缝现在由 style-pins.css 的透明桥接(`.cs-pin.is-open::after`)补成
 *  pin 自己的命中区 —— 缝里的像素不再落到画板上。宽限留着兜快速甩动:鼠标一帧跨过整条桥
 *  时 mouseleave 照样会来,250ms 内不关,按钮还点得到。 */
function attachHoverGrace(pin: HTMLElement): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  pin.addEventListener("mouseenter", () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    pin.classList.add("is-open")
  })
  pin.addEventListener("mouseleave", () => {
    timer = setTimeout(() => {
      // 编辑中不自动关(textarea 里打字时鼠标可能移走)
      if (!pin.querySelector(".cs-pin-bubble.is-editing")) pin.classList.remove("is-open")
    }, 250)
  })
}

/** 一条批注挂的参考图:「图片 n」占位符 + 缩略图预览,点开大图,✕ 移除(按下标,与正文 [图片 n] 同步) */
function refStrip(paths: string[], onRemove?: (idx: number) => void): HTMLElement {
  const strip = h("div", "cs-ref-strip")
  paths.forEach((p, i) => {
    if (p === UPLOADING) {
      strip.appendChild(h("div", "cs-ref-thumb is-broken", `图片 ${i + 1} · 上传中…`))
      return
    }
    strip.appendChild(refThumb(p, { index: i + 1, onRemove: onRemove ? () => onRemove(i) : undefined }))
  })
  return strip
}

function bubble(ann: Annotation): HTMLElement {
  const box = h("div", "cs-pin-bubble")
  const textEl = h("div", "cs-pin-text", ann.text)
  box.appendChild(textEl)
  if (ann.refs?.length) {
    box.appendChild(
      refStrip(ann.refs, (idx) => {
        const next = (ann.refs ?? []).filter((_, i) => i !== idx)
        void transition(
          ann.id,
          { refs: next, text: removeRefToken(ann.text, idx + 1) },
          "参考图已移除(文件保留在 refs/ 里)"
        )
      })
    )
  }
  const meta = h("div", "cs-pin-meta")
  meta.appendChild(h("span", undefined, ann.status === "open" ? "open" : "待核验"))

  const act = (label: string, cls: string, fn: () => void): void => {
    const btn = h("button", cls, label)
    btn.addEventListener("click", (e) => {
      e.stopPropagation()
      fn()
    })
    meta.appendChild(btn)
  }

  if (ann.status === "open") {
    // Claude(或人)标记"做完了" —— 进入待核验,还不消失
    act("标记完成", "cs-x", () =>
      void transition(ann.id, { status: "resolved", resolvedAt: new Date().toISOString() }, "已标记完成,待人工核验")
    )
  } else {
    // 核验是人的专属动作:通过 → 从墙上消失,进历史;不通过 → 打回 open
    act("核验通过", "cs-x", () =>
      void transition(ann.id, { status: "verified", verifiedAt: new Date().toISOString() }, "核验通过,已归档进历史")
    )
    act("打回", "cs-x", () => void transition(ann.id, { status: "open" }, "已打回,重新待处理"))
  }
  act("编辑", "cs-x", () => startEdit(box, textEl, ann))
  act("删除", "cs-x cs-x-danger", () => void remove(ann.id))
  box.appendChild(meta)
  return box
}

async function transition(id: string, patch: Partial<Annotation>, msg: string): Promise<void> {
  try {
    const updated = await patchAnnotation(id, patch)
    upsert(updated)
    renderPins()
    toast(msg, "ok")
  } catch (err) {
    toast(`批注状态更新失败:${err}`, "error")
  }
}

/** 就地改批注文字 + 挂参考图:文本换成 textarea,保存走 PATCH,SSE 会把新内容推给所有客户端 */
function startEdit(box: HTMLElement, textEl: HTMLElement, ann: Annotation): void {
  if (box.querySelector("textarea")) return
  box.classList.add("is-editing") // 编辑中气泡常显,不再依赖 hover
  const ta = h("textarea", "cs-pin-edit") as unknown as HTMLTextAreaElement
  ta.value = ann.text

  // 编辑态里粘贴的图挂到这条批注。先只暂存,和文字一起在「保存」时 PATCH ——
  // 立刻 PATCH 会经 SSE 触发 renderPins,把用户正在打的字连输入框一起冲掉。
  const refs = [...(ann.refs ?? [])]
  // 编辑态的 strip 整个重建:增删都只动暂存数组,「保存」时一并 PATCH
  let strip = box.querySelector<HTMLElement>(".cs-ref-strip")
  const redrawStrip = (): void => {
    const next = refStrip(refs, (idx) => {
      refs.splice(idx, 1)
      ta.value = removeRefToken(ta.value, idx + 1) // 正文里的 [图片 n] 同步摘掉并重编号
      redrawStrip()
    })
    if (strip?.isConnected) strip.replaceWith(next)
    else box.insertBefore(next, box.querySelector(".cs-pin-meta"))
    strip = next
  }
  redrawStrip()
  // 粘贴 = 光标处插 [图片 n] 占位符(Claude Code 同款:图有位置),上传完成回填路径
  setPasteTarget({
    el: box,
    onFile: (file) => attachInline(ta, refs, file, redrawStrip),
  })
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation() // 编辑时不触发画布快捷键
    // Enter 保存(Shift+Enter 才是换行),Esc 取消 —— 全局快捷键在输入框里被挡掉了,
    // 所以"Enter 编辑/保存"这条闭环必须在这里自己接上
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      save.click()
    } else if (e.key === "Escape") {
      e.preventDefault()
      renderPins()
    }
  })
  ta.addEventListener("mousedown", (e) => e.stopPropagation())
  const row = h("div", "cs-pin-meta")
  const save = h("button", "cs-x", "保存")
  save.addEventListener("click", (e) => {
    e.stopPropagation()
    if (refs.includes(UPLOADING)) return toast("有图片还在上传,稍等一下再保存", "warn")
    const text = ta.value.trim()
    const textChanged = !!text && text !== ann.text
    const refsChanged = JSON.stringify(refs) !== JSON.stringify(ann.refs ?? [])
    if (!textChanged && !refsChanged) return renderPins()
    const patch: Partial<Annotation> = {}
    if (textChanged) patch.text = text
    if (refsChanged) patch.refs = refs
    void patchAnnotation(ann.id, patch)
      .then((updated) => {
        upsert(updated)
        renderPins()
        toast("批注已更新", "ok")
      })
      .catch((err) => toast(`批注更新失败:${err}`, "error"))
  })
  const cancel = h("button", "cs-x", "取消")
  cancel.addEventListener("click", (e) => {
    e.stopPropagation()
    renderPins() // 重画即还原
  })
  row.appendChild(save)
  row.appendChild(cancel)
  textEl.replaceWith(ta)
  box.appendChild(row)
  ta.focus()
  ta.setSelectionRange(ta.value.length, ta.value.length)
}

async function remove(id: string): Promise<void> {
  try {
    await deleteAnnotation(id)
    state.annotations = state.annotations.filter((a) => a.id !== id)
    renderPins()
    toast("批注已删除", "ok")
  } catch (err) {
    toast(`批注删除失败:${err}`, "error")
  }
}

/** 旧版本把上次选的会话记在这里。现在每次都问,顺手把残留的键清掉 */
function legacyPushMemKey(): string {
  return `cs-pushpid:${state.info?.projectRoot ?? "unknown"}`
}

/**
 * 一键推送。**不记忆会话**:只要有多个候选,每次推送都弹选择器让人当场选
 * ——推错窗口的代价远大于每次点一下。唯一候选时服务端直发(不打扰)。
 * pid 只可能来自刚才那个选择器。
 * (第二个参数是 Shift+P「强制重选」的遗留入参,现在恒等于默认行为,留着只为让 modes.ts 编译过;
 *  见完成报告:集成负责人删掉 modes.ts 的 Shift+P 分支后可一并去掉。)
 */
export async function pushToClaudeCode(pid?: number): Promise<void> {
  setProbe("推送中…")
  try {
    try {
      localStorage.removeItem(legacyPushMemKey())
    } catch {
      /* 清不掉也无所谓,反正不再读它 */
    }
    let r = await pushContext(pid)
    // 刚选的会话在这一瞬间关掉了 → 重新列一遍(会拿到新的 choose 或唯一候选)
    if (!r.ok && "reason" in r && r.reason?.includes("已不在") && pid !== undefined) {
      r = await pushContext()
    }
    if (r.ok) {
      // 说"已投递"而不是"已送达":Claude Code 的 inbound gate 会按权限模式 hold/refuse,
      // 目标会话开着 --dangerously-skip-permissions 时对方终端弹的是审批框,不是直接接活
      toast(`已投递到「${r.name}」的 inbox — 该会话可能需要你在终端点一下确认`, "ok")
      return
    }
    if ("choose" in r && r.choose?.length) {
      showSessionPicker(r.choose)
      return
    }
    toast(`${("reason" in r && r.reason) || "推送失败"} —— 已回落为复制到剪贴板`, "warn")
    await copyContext()
  } catch (err) {
    toast(`推送失败:${err} —— 已回落为复制到剪贴板`, "warn")
    await copyContext()
  }
}

/** 会话选择器:同目录开了多个 Claude 窗口时,按名字挑一个(数字键/点击,Esc 取消) */
function showSessionPicker(items: Array<{ pid: number; name: string; status: string }>): void {
  document.getElementById("cs-picker")?.remove()
  const wrap = h("div", "cs-picker")
  wrap.id = "cs-picker"
  const card = h("div", "cs-card")
  card.appendChild(h("h2", undefined, "推送给哪个会话?"))

  // cleanup 必须在行点击之前定义:只 remove 不摘监听会把捕获期 keydown 留在 document 上,
  // 之后在批注输入框里打数字就会静默触发推送(捕获期跑在输入框的 stopPropagation 之前)
  const cleanup = (): void => {
    document.removeEventListener("keydown", onKey, true)
    wrap.remove()
  }

  items.slice(0, 9).forEach((it, i) => {
    const row = h(
      "button",
      "cs-picker-row",
      `${i + 1}  ${it.name}`
    )
    const badge = h("span", `cs-picker-status is-${it.status}`, it.status)
    row.appendChild(badge)
    row.addEventListener("click", () => {
      cleanup()
      void pushToClaudeCode(it.pid)
    })
    card.appendChild(row)
  })
  card.appendChild(h("p", "cs-dim", "数字键选择 · Esc 取消"))
  wrap.appendChild(card)
  const onKey = (e: KeyboardEvent): void => {
    const n = Number(e.key)
    if (Number.isInteger(n) && n >= 1 && n <= Math.min(items.length, 9)) {
      e.stopPropagation()
      cleanup()
      void pushToClaudeCode(items[n - 1]!.pid)
    } else if (e.key === "Escape") {
      e.stopPropagation()
      cleanup()
      toast("已取消推送")
    }
  }
  document.addEventListener("keydown", onKey, true)
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) cleanup()
  })
  document.body.appendChild(wrap)
}

/** 复制批注给 Claude:与 hook 注入终端的是同一份 /api/context 文本 */
export async function copyContext(): Promise<void> {
  try {
    const text = await fetchContext()
    if (!text.trim()) {
      toast("没有待处理的批注或选中,先按 c 钉一条", "warn")
      return
    }
    await navigator.clipboard.writeText(text)
    const n = state.annotations.filter((a) => a.status === "open").length
    toast(`已复制 ${n} 条批注(含选中),粘到任何 Claude Code 窗口即可`, "ok")
  } catch (err) {
    toast(`复制失败:${err}`, "error")
  }
}

function upsert(ann: Annotation): void {
  const i = state.annotations.findIndex((a) => a.id === ann.id)
  if (i >= 0) state.annotations[i] = ann
  else state.annotations.push(ann)
}

/** 点了元素,就地开一个小输入框 */
export function openComposer(board: Board, el: Element, clientX: number, clientY: number): void {
  closeComposer()
  const selector = buildSelector(el)
  const rel = relPos(el, clientX, clientY, board)

  const box = h("div", "cs-pin-input")
  box.style.left = `${Math.min(clientX + 10, window.innerWidth - 250)}px`
  // 170 而不是 110:贴一行参考图缩略图后这个框会长到约 150px 高,靠近屏幕底边钉 pin 时别露出去
  box.style.top = `${Math.min(clientY + 10, window.innerHeight - 170)}px`
  const ta = h("textarea")
  ta.placeholder = `批注 ${selector}`
  const strip = refStrip([])
  const tip = h("div", "cs-pin-tip", "Enter 提交 · Shift+Enter 换行 · Cmd/Ctrl+V 贴参考图 · Esc 取消")
  box.append(ta, strip, tip)
  fx.appendChild(box)
  composer = box
  ta.focus()

  // 输入框开着时粘贴的图归这条批注(随创建请求一起提交),不再进全局坞。
  // 粘贴 = 光标处插 [图片 n] 占位符,✕ 摘掉时正文同步重编号
  const refs: string[] = []
  let stripEl = strip
  const redrawStrip = (): void => {
    const next = refStrip(refs, (idx) => {
      refs.splice(idx, 1)
      ta.value = removeRefToken(ta.value, idx + 1)
      redrawStrip()
    })
    stripEl.replaceWith(next)
    stripEl = next
  }
  setPasteTarget({
    el: box,
    onFile: (file) => attachInline(ta as HTMLTextAreaElement, refs, file, redrawStrip),
  })

  ta.addEventListener("keydown", (e: KeyboardEvent) => {
    e.stopPropagation() // 别让画布快捷键抢走按键
    if (e.key === "Escape") {
      closeComposer()
      exitPinMode()
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (refs.includes(UPLOADING)) return toast("有图片还在上传,稍等一下再提交", "warn")
      const text = ta.value.trim()
      if (!text) {
        closeComposer()
        exitPinMode()
        return
      }
      void submit(board, selector, rel, text, refs)
    }
  })
}

async function submit(
  board: Board,
  selector: string,
  rel: { x: number; y: number },
  text: string,
  refs: string[]
): Promise<void> {
  closeComposer()
  // 不退出批注模式:走查一遍界面往往要连钉好几条,每条都重按一次 c 是纯摩擦。
  // Esc 退出,HUD 会显示"批注中 · 已钉 N"。
  try {
    const ann = await createAnnotation({
      artboardId: board.entry.id,
      anchor: { selector, x: rel.x, y: rel.y },
      text,
      refs,
      status: "open",
    })
    upsert(ann)
    renderBoardPins(board)
    state.pinnedThisRun++
    syncHud()
    const withRefs = refs.length ? ` · 带 ${refs.length} 张参考图` : ""
    toast(`已记批注:${text.slice(0, 30)}${text.length > 30 ? "…" : ""}${withRefs}`, "ok")
  } catch (err) {
    toast(`批注失败:${String(err)}`, "error")
  }
}

export function closeComposer(): void {
  composer?.remove()
  composer = null
  setPasteTarget(null) // 输入框没了,粘贴回到全局坞
}

export function isComposing(): boolean {
  return composer !== null
}

export function enterPinMode(): void {
  state.pinPending = true
  state.pinnedThisRun = 0
  syncHud()
  setProbe("批注模式:点元素落 pin,可连钉多条,Esc 退出")
}

export function exitPinMode(): void {
  if (!state.pinPending) return
  state.pinPending = false
  if (state.pinnedThisRun > 0)
    toast(`本轮钉了 ${state.pinnedThisRun} 条批注 · 按 p 推给 Claude`, "info")
  state.pinnedThisRun = 0
  syncHud()
  setProbe("移到画板上反查元素")
}
