// dev server 僵死时的全局横幅。
// 没有它,僵死表现为满墙画板各自破图,用户的归因是"contactsheet 崩了"——
// 一条横幅把三件事说清:坏的是谁、画布为什么没坏、怎么救。
// 显示的是绝对时刻(最后正常 HH:MM:SS),不做滴答倒计时(COMP-009:时间驱动 UI 锚定绝对时刻)。
import { h } from "./dom.js"

let el: HTMLDivElement | null = null
let lastOkAt: number | undefined

export function setLastOk(ts?: number): void {
  lastOkAt = ts
}

export function showUnhealthy(detail?: string): void {
  hideUnhealthy()
  const at = lastOkAt ? new Date(lastOkAt).toLocaleTimeString("zh-CN", { hour12: false }) : null
  el = h("div", "cs-health") as HTMLDivElement
  el.setAttribute("role", "alert")
  el.appendChild(h("b", undefined, "你的 dev server 没响应了"))
  el.appendChild(
    h(
      "span",
      undefined,
      `${detail ?? "SSR 探测失败"}${at ? ` · 最后正常 ${at}` : ""} —— 画布没坏,画板破图是它渲染不出来。通常重启 next dev 即愈。`
    )
  )
  document.body.appendChild(el)
}

export function hideUnhealthy(): void {
  el?.remove()
  el = null
}
