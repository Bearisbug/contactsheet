// 目标 dev server 的健康探测。
// 动机(Synco 实测现场):画布长开 + 用户持续改代码,next dev 可能进入僵死态 ——
// 进程活着、端口 LISTEN、静态资源 200,但 SSR 秒 500、API 永久挂起。此时画布上
// 每块画板各自破图,用户看到的是"contactsheet 崩了",归因完全错了。
// 这里主动探测并广播一个**全局**状态,让画布用一条横幅把话说清楚。
//
// 探测目标选 /__cs/registry:它是注入进用户 app 的 RSC 路由,走的正是僵死指纹里
// 挂掉的那条 server 渲染路径 —— 静态资源探测在这种故障下会给假阴性。
import type { CsConfig, CsEvent } from "../types.js"

export interface HealthState {
  ok: boolean
  /** 不健康时的一句话诊断(超时/HTTP 5xx/连不上) */
  detail?: string
  /** 最后一次探测成功的时间戳(ms);从未成功过则缺省 */
  lastOkAt?: number
}

const INTERVAL_MS = Number(process.env.CS_HEALTH_INTERVAL_MS ?? 20000)
const TIMEOUT_MS = Number(process.env.CS_HEALTH_TIMEOUT_MS ?? 10000)
/** 连续失败这么多次才算不健康:单次抖动(大项目冷编译、瞬时高负载)不该拉横幅 */
const FAILS_TO_TRIP = 2

let current: HealthState = { ok: true }

export function currentHealth(): HealthState {
  return current
}

export function startHealthMonitor(
  cfg: CsConfig,
  broadcast: (ev: CsEvent) => void
): { close(): void } {
  let fails = 0
  let everOk = false
  let timer: NodeJS.Timeout | null = null

  const probe = async (): Promise<void> => {
    let failDetail: string | null = null
    try {
      const r = await fetch(`${cfg.target}/__cs/registry`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (r.ok || r.status === 404) {
        // 404 也算活着:clean 过注入文件时路由不存在,但 server 本身在正常干活
        everOk = true
        fails = 0
        if (!current.ok) {
          current = { ok: true, lastOkAt: Date.now() }
          broadcast({ type: "health", ok: true })
        } else {
          current = { ok: true, lastOkAt: Date.now() }
        }
        return
      }
      failDetail = `SSR 探测返回 HTTP ${r.status}`
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string } }
      failDetail =
        e.name === "TimeoutError"
          ? `SSR 探测 ${TIMEOUT_MS / 1000}s 无响应`
          : `连不上(${e.cause?.code ?? "network"})`
    }
    // 从未成功过就不判死刑:冷启动/大项目首编期间的失败由画布错误卡负责,不归横幅
    if (!everOk) return
    fails++
    if (fails >= FAILS_TO_TRIP && current.ok) {
      current = { ok: false, detail: failDetail ?? "未知", lastOkAt: current.lastOkAt }
      broadcast({ type: "health", ok: false, detail: current.detail })
      console.warn(`[contactsheet] ⚠ 目标 ${cfg.target} 疑似僵死:${current.detail}(静态可能仍 200)。画布已挂横幅。`)
    }
  }

  timer = setInterval(() => void probe(), INTERVAL_MS)
  timer.unref()
  void probe()
  return {
    close() {
      if (timer) clearInterval(timer)
    },
  }
}
