// 终端输出的色彩与符号:零依赖 ANSI。
// 约定:✓ 绿 = 完成;⚠ 黄 = 要注意但不致命;✖ 红 = 失败;● 青 = 地址/入口;暗淡 = 次要信息。
// 尊重 NO_COLOR(https://no-color.org)与非 TTY(管道/重定向时输出纯文本,日志不带转义码)。

const on = process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb"

const wrap = (open: number, close: number) => (s: string) =>
  on ? `\x1b[${open}m${s}\x1b[${close}m` : s

export const bold = wrap(1, 22)
export const dim = wrap(2, 22)
export const red = wrap(31, 39)
export const green = wrap(32, 39)
export const yellow = wrap(33, 39)
export const cyan = wrap(36, 39)
export const magenta = wrap(35, 39)

/** 链接:青色 + 下划线,现代终端可点 */
export const link = (s: string): string => (on ? `\x1b[36;4m${s}\x1b[39;24m` : s)

export const ok = (s: string): string => `${green("✓")} ${s}`
export const warn = (s: string): string => `${yellow("⚠")} ${yellow(s)}`
export const fail = (s: string): string => `${red("✖")} ${s}`

/** 短暂的行内 spinner:每次调用推进一帧,行尾用 \r 原地刷新。非 TTY 下静默 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
let frame = 0
export function spin(text: string): void {
  if (!on) return
  process.stdout.write(`\r${cyan(FRAMES[frame++ % FRAMES.length])} ${text}\x1b[K`)
}
export function spinDone(): void {
  if (!on) return
  process.stdout.write("\r\x1b[K")
}
