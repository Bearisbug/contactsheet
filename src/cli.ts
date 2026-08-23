// contactsheet CLI:默认 up(注入 → 监听 → 起外壳),另有 init / clean
import { parseArgs } from "node:util"
import { loadConfig } from "./config.js"
import { ensureInjected, removeInjected } from "./inject/index.js"
import { runInit } from "./init/index.js"
import { broadcast, startServer } from "./server/index.js"
import { closeBrowser } from "./shot/index.js"
import { startWatcher } from "./watch/index.js"
import type { CsConfig } from "./types.js"

const HELP = `contactsheet —— 把 UI 的各种状态摊在一面可缩放的墙上

  contactsheet [up]     附着到当前 Next.js repo:注入画板路由 + 起外壳(默认命令)
  contactsheet init     初始化配置、.mcp.json、hook,并自动铺一批画板
  contactsheet clean    移除注入的文件

  --port <n>            外壳端口(默认 5199)
  --target <url>        next dev 地址(默认 http://localhost:3000)
  --design-dir <dir>    画板目录(默认 design)
  -h, --help            显示本帮助`

main().catch((err: unknown) => {
  console.error(`[contactsheet] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: "string" },
      target: { type: "string" },
      "design-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  })

  if (values.help) {
    console.log(HELP)
    return
  }

  const flags: Partial<CsConfig> = {}
  if (values.port !== undefined) {
    const port = Number(values.port)
    if (!Number.isInteger(port)) throw new Error(`--port 不是整数:${values.port}`)
    flags.port = port
  }
  if (values.target !== undefined) flags.target = values.target
  if (values["design-dir"] !== undefined) flags.designDir = values["design-dir"]

  const cmd = positionals[0] ?? "up"
  if (cmd === "up") return up(flags)
  if (cmd === "init") return runInit(process.cwd(), flags)
  if (cmd === "clean") return removeInjected(loadConfig(process.cwd(), flags))

  console.error(`未知命令:${cmd}\n\n${HELP}`)
  process.exit(1)
}

async function up(flags: Partial<CsConfig>): Promise<void> {
  const cfg = loadConfig(process.cwd(), flags)

  // 注入与文件监听归 Agent B;这两步失败只告警,外壳照常起(画布本身不依赖它们)
  await tryStep("注入画板路由", () => ensureInjected(cfg))
  const watcher = await tryStep("启动文件监听", () =>
    startWatcher(cfg, (entries) => broadcast({ type: "registry", entries }))
  )

  const server = await startServer(cfg)
  banner(cfg)

  let closing = false
  const shutdown = async (sig: string): Promise<void> => {
    if (closing) return
    closing = true
    console.log(`\n[contactsheet] 收到 ${sig},正在退出…`)
    if (watcher) await quiet(() => watcher.close())
    await quiet(() => server.close())
    await quiet(() => closeBrowser())
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
}

/** 跑一步,失败只告警不中断(对面模块可能还是 stub) */
async function tryStep<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    console.warn(`[contactsheet] ${label}失败,已跳过:${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** 退出路径上的调用,出错不追究 */
async function quiet(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch {
    // 正在退出,忽略
  }
}

function banner(cfg: CsConfig): void {
  console.log(`
  contactsheet   http://localhost:${cfg.port}/__cs
  代理目标       ${cfg.target}
  画板目录       ${cfg.designDir}/   ·   app 目录 ${cfg.appDir}/
  Ctrl-C 退出
`)
}
