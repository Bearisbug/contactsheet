// 左下角 HUD:模式指示 + 反查信息行
import { qs } from "./dom.js"
import { state } from "./state.js"

let modeEl: HTMLElement
let probeEl: HTMLElement

const MODE_LABEL: Record<string, string> = { browse: "浏览", interact: "交互", review: "走查" }

export function initHud(): void {
  modeEl = qs("#cs-mode")
  probeEl = qs("#cs-probe")
  syncHud()
}

export function syncHud(): void {
  // 批注模式下带上本轮计数,让"可以连钉"这件事自己说出来
  const n = state.pinPending ? state.pinnedThisRun : 0
  modeEl.textContent = state.pinPending
    ? n > 0
      ? `批注中 · 已钉 ${n}`
      : "批注中"
    : MODE_LABEL[state.mode]
  document.body.dataset.mode = state.mode
  document.body.dataset.pin = state.pinPending ? "on" : "off"
}

/** 信息行:hover 反查结果 / 操作回执 */
export function setProbe(text: string): void {
  probeEl.textContent = text
}
