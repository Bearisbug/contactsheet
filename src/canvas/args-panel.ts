// 右侧 args 面板:读 iframe 里的 #__cs_meta,按值类型出控件,改动去抖后重载 iframe
import { boardUrl } from "./api.js"
import { debounce, frameDoc, h, qs } from "./dom.js"
import { setProbe } from "./hud.js"
import { state, type Board } from "./state.js"

let panel: HTMLElement
let openId: string | null = null
/** 每个字段一个读值函数,返回 undefined 表示这次先别改(比如 JSON 没写完) */
let readers: Array<{ key: string; read(): unknown }> = []

export function initArgsPanel(): void {
  panel = qs("#cs-args")
}

/** 从画板 iframe 里读 __cs_meta;读不到就退回 registry 上的默认 args */
function readMeta(board: Board): Record<string, unknown> | null {
  const doc = frameDoc(board.iframe)
  const node = doc?.getElementById("__cs_meta")
  if (node?.textContent) {
    try {
      const meta = JSON.parse(node.textContent) as { args?: Record<string, unknown> }
      if (meta && typeof meta === "object" && meta.args && typeof meta.args === "object") return meta.args
    } catch {
      /* 落到下面的兜底 */
    }
  }
  return board.argsOverride ?? board.entry.args ?? null
}

export function closeArgsPanel(): void {
  openId = null
  readers = []
  panel.hidden = true
  panel.textContent = ""
  document.body.dataset.args = "closed"
}

export function isArgsOpen(id: string): boolean {
  return openId === id
}

export function openArgsPanel(board: Board): void {
  openId = board.entry.id
  readers = []
  panel.textContent = ""
  panel.hidden = false
  document.body.dataset.args = "open"

  const head = h("div", "cs-args-head")
  const title = h("div", "cs-args-title", board.entry.exportName)
  const close = h("button", "cs-x", "✕")
  close.title = "关闭"
  close.addEventListener("click", closeArgsPanel)
  head.append(title, close)

  const sub = h("div", "cs-args-sub", `${board.entry.file}\n${board.entry.kind} · ${board.entry.id}`)
  const body = h("div", "cs-args-body")

  const args = readMeta(board)
  const keys = args ? Object.keys(args) : []
  if (!args || keys.length === 0) {
    body.appendChild(
      h(
        "div",
        "cs-args-empty",
        board.entry.kind === "screen"
          ? "screen 画板没有 args(它直接渲染目标页面)。"
          : "这个画板没有声明 args。在 .artboard.tsx 里加 args: { … } 就能在这里调。"
      )
    )
  } else {
    for (const key of keys) body.appendChild(field(key, args[key]))
  }

  const foot = h("div", "cs-args-foot")
  const save = h("button", undefined, "存为画板")
  save.disabled = true
  save.title = "v1 未实现:改好的 args 请手动写回 .artboard.tsx 新增一个 export"
  foot.appendChild(save)

  panel.append(head, sub, body, foot)
}

const applySoon = debounce(300, () => {
  if (!openId) return
  const board = state.boards.get(openId)
  if (!board) return
  const next: Record<string, unknown> = { ...(readMeta(board) ?? {}) }
  for (const f of readers) {
    const v = f.read()
    if (v === undefined) return // 有字段还不合法,整批不发
    next[f.key] = v
  }
  board.argsOverride = next
  const url = boardUrl(board.entry, next)
  const win = board.iframe?.contentWindow
  if (win) win.location.replace(url)
  else if (board.iframe) board.iframe.src = url
  if (board.iframe) board.iframe.dataset.csUrl = url
  setProbe(`args 已应用:${url.slice(0, 70)}`)
})

function field(key: string, value: unknown): HTMLElement {
  const wrap = h("div", "cs-field")

  if (typeof value === "boolean") {
    wrap.classList.add("is-bool")
    const label = h("label")
    const input = h("input")
    input.type = "checkbox"
    input.checked = value
    input.dataset.key = key
    label.append(input, h("span", undefined, key))
    wrap.appendChild(label)
    readers.push({ key, read: () => input.checked })
    input.addEventListener("change", applySoon)
    return wrap
  }

  if (typeof value === "number") {
    wrap.appendChild(h("label", undefined, key))
    const input = h("input")
    input.type = "number"
    input.value = String(value)
    wrap.appendChild(input)
    readers.push({
      key,
      read: () => {
        const n = Number(input.value)
        return input.value.trim() === "" || Number.isNaN(n) ? undefined : n
      },
    })
    input.addEventListener("input", applySoon)
    return wrap
  }

  if (typeof value === "string") {
    wrap.appendChild(h("label", undefined, key))
    const input = h("input")
    input.type = "text"
    input.value = value
    wrap.appendChild(input)
    readers.push({ key, read: () => input.value })
    input.addEventListener("input", applySoon)
    return wrap
  }

  // 其余类型(对象/数组/null)走 JSON 文本框
  wrap.appendChild(h("label", undefined, `${key} (JSON)`))
  const ta = h("textarea")
  ta.value = JSON.stringify(value ?? null, null, 2)
  wrap.appendChild(ta)
  readers.push({
    key,
    read: () => {
      try {
        return JSON.parse(ta.value) as unknown
      } catch {
        ta.style.borderColor = "var(--cs-danger)"
        return undefined
      }
    },
  })
  ta.addEventListener("input", () => {
    ta.style.borderColor = ""
    applySoon()
  })
  return wrap
}
