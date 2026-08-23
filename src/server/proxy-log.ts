// 代理错误日志的去重+限流。
// next dev 挂掉或重启时,浏览器里 Next 的 HMR 客户端会疯狂重连,每次带一个新的 ?id= ——
// 逐条打印就是一秒几十行,真正的错误全被冲走。这里把同类失败压成一条,并把"目标整个连不上"
// 单独拎出来说一句人话。

import { dim, green, red, yellow } from "../term.js"

/** 同类失败的合并窗口 */
const WINDOW_MS = 5000

export interface ProxyLog {
  /** 记一次代理失败(http 与 ws 共用),自行决定打不打 */
  fail(err: NodeJS.ErrnoException, url: string | undefined): void
  /** 目标有回包(http 响应 / ws 握手成功)—— 活着 */
  alive(): void
  /** 退出时清掉挂起的窗口定时器 */
  close(): void
}

export function createProxyLog(target: string): ProxyLog {
  // key = 错误码 + 去掉查询串的路径;窗口内首条直接打,其余只计数
  const windows = new Map<string, { extra: number; timer: NodeJS.Timeout }>()
  let down = false // 目标整体不可达(ECONNREFUSED)
  let silenced = 0 // 不可达期间压掉的失败次数

  return {
    fail(err, url) {
      const code = err.code ?? err.message

      // 目标没起:第一次说一句有用的,之后闭嘴到恢复为止。HMR 重连的洪水绝大多数是这一支
      if (code === "ECONNREFUSED") {
        if (down) {
          silenced++
          return
        }
        down = true
        console.error(
          `${yellow("⚠")} ${yellow(`目标 ${target} 连不上了`)} —— 起 next dev 后会自动恢复(画布会自己重试)。` +
            dim("期间的代理失败不再逐条打印。")
        )
        return
      }

      const key = `${code} ${pathOf(url)}`
      const win = windows.get(key)
      if (win) {
        win.extra++
        return
      }
      console.error(`${red("✖")} 代理失败 ${pathOf(url)} ${red(String(code))}`)
      const timer = setTimeout(() => {
        const extra = windows.get(key)?.extra ?? 0
        windows.delete(key)
        if (extra > 0) {
          console.error(dim(`  (过去 ${WINDOW_MS / 1000} 秒还有 ${extra} 次同类失败:${key})`))
        }
      }, WINDOW_MS)
      timer.unref()
      windows.set(key, { extra: 0, timer })
    },

    alive() {
      if (!down) return
      down = false
      const n = silenced
      silenced = 0
      console.log(`${green("✓")} ${green(`目标 ${target} 已恢复`)}${n > 0 ? dim(`(不可达期间压掉 ${n} 条代理失败)`) : ""}`)
    },

    close() {
      for (const win of windows.values()) clearTimeout(win.timer)
      windows.clear()
    },
  }
}

/** 去掉查询串:HMR 重连每次带新的 ?id=,不去掉就永远合并不到一起 */
function pathOf(url: string | undefined): string {
  if (!url) return "(无 url)"
  const q = url.indexOf("?")
  return q < 0 ? url : url.slice(0, q)
}
