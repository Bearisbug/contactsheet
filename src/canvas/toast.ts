// 一次性回执通道。以前所有结果都写进左下角 HUD 的 probe 行——那行同时还是
// hover 反查的实时读数,鼠标一动就把"已推送给 X"擦掉了。
// 规则:probe 只留持续读数(反查/拖拽尺寸/模式说明),一次性结果一律走 toast。
import { h, qs } from "./dom.js"

export type ToastKind = "info" | "ok" | "warn" | "error"

let host: HTMLElement | null = null

function ensureHost(): HTMLElement {
  if (host) return host
  host = document.getElementById("cs-toasts")
  if (!host) {
    host = h("div", "cs-toasts")
    host.id = "cs-toasts"
    qs("body").appendChild(host)
  }
  return host
}

/** 弹一条回执。error 停留久一点(用户多半要读全) */
export function toast(text: string, kind: ToastKind = "info"): void {
  const el = h("div", `cs-toast is-${kind}`, text)
  ensureHost().appendChild(el)
  // 入场:下一帧加 is-in,让 transition 有起点
  requestAnimationFrame(() => el.classList.add("is-in"))
  const life = kind === "error" ? 6000 : kind === "warn" ? 4500 : 3000
  setTimeout(() => {
    el.classList.remove("is-in")
    el.addEventListener("transitionend", () => el.remove(), { once: true })
    setTimeout(() => el.remove(), 400) // transitionend 万一不来的兜底
  }, life)
}
