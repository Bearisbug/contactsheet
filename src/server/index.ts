// 外壳 HTTP 服务:只占 /__cs 前缀,其余一切(含 WebSocket)代理到用户的 next dev
import fs from "node:fs"
import http from "node:http"
import httpProxy from "http-proxy"
import type { CsConfig, RegistryEntry } from "../types.js"
import type { McpServices } from "../mcp/index.js"
import { createMcpHandler } from "../mcp/index.js"
import { screenshot } from "../shot/index.js"
import { errText, handleApi, pushToken, sendText } from "./api.js"
import { findUiFile, mimeOf } from "./assets.js"
import { createProxyLog } from "./proxy-log.js"
import * as sse from "./sse.js"
import * as store from "./store.js"

// SSE hub 是模块级的(startServer 的返回值签名冻结,推事件只能走这个额外导出)
export { broadcast } from "./sse.js"

type McpHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>

export async function startServer(cfg: CsConfig): Promise<{ close(): Promise<void> }> {
  const proxy = httpProxy.createProxyServer({ target: cfg.target, ws: true, changeOrigin: true })

  // next dev 没起时给一张说明页,画布自身照常可开。日志走 proxyLog 去重限流:
  // HMR 客户端重连时每秒几十次失败,逐条打会把真错误冲走
  const proxyLog = createProxyLog(cfg.target)
  proxy.on("error", (err, req, res) => {
    proxyLog.fail(err as NodeJS.ErrnoException, req?.url)
    if (!res) return
    if ("writeHead" in res) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/html; charset=utf-8" })
      res.end(downPage(cfg.target))
    } else {
      // ws 升级失败:http-proxy 只 end() 了客户端 socket,这里补一刀,别留半开连接
      res.destroy()
    }
  })
  // 目标有回包就算活过来了(http 响应 / ws 握手),用来打"已恢复"那一行
  proxy.on("proxyRes", () => proxyLog.alive())
  proxy.on("open", () => proxyLog.alive())

  // MCP handler 由 Agent D 提供;还是 stub 就挂 501,不影响其余功能
  let mcp: McpHandler | null = null
  try {
    mcp = createMcpHandler(makeServices(cfg))
  } catch (err) {
    console.warn(`[contactsheet] MCP 未就绪(/__cs/mcp 返回 501):${errText(err)}`)
  }

  const server = http.createServer((req, res) => {
    handle(cfg, proxy, mcp, req, res).catch((err) => {
      console.error(`[contactsheet] 请求处理失败 ${req.url}`, err)
      if (!res.headersSent) sendText(res, 500, errText(err))
      else res.end()
    })
  })

  // HMR WebSocket 走这条
  server.on("upgrade", (req, socket, head) => proxy.ws(req, socket, head))

  // 自己追踪全部 socket:升级成 WebSocket 的代理连接不在 closeAllConnections 的清单里,
  // 不干掉它们 server.close 永远不回调 —— Ctrl-C 时画布还开着就会卡死在退出半途
  const sockets = new Set<import("node:net").Socket>()
  server.on("connection", (s) => {
    sockets.add(s)
    s.on("close", () => sockets.delete(s))
  })

  // 只绑回环:画布没有鉴权,而 /__cs/api/push 能把任意文本以"用户发言"送进你的 Claude Code
  // 会话。裸绑 0.0.0.0 等于把这条执行链暴露给同一个 Wi-Fi 上的任何人。要 LAN 访问必须显式 --host。
  const host = cfg.host ?? "127.0.0.1"
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(cfg.port, host, () => {
      server.off("error", reject)
      resolve()
    })
  })
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.warn(
      `[contactsheet] ⚠️  监听在 ${host}:${cfg.port} —— 画布无鉴权,同网络的任何人都能读你的批注、` +
        `并向你的 Claude Code 会话推送消息。只在可信网络这么做。`
    )
  }

  return {
    async close() {
      sse.closeAll()
      proxyLog.close()
      proxy.close()
      await new Promise<void>((resolve) => {
        const fallback = setTimeout(resolve, 2000) // 兜底:2 秒关不干净也照样退出
        for (const s of sockets) s.destroy()
        server.closeAllConnections()
        server.close(() => {
          clearTimeout(fallback)
          resolve()
        })
      })
    },
  }
}

async function handle(
  cfg: CsConfig,
  proxy: ReturnType<typeof httpProxy.createProxyServer>,
  mcp: McpHandler | null,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  // 只按 pathname 路由,query 留给各 handler 自己看
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname

  if (pathname === "/__cs" || pathname === "/__cs/") return serveUi(res, "index.html")

  if (pathname.startsWith("/__cs/ui/")) {
    const name = pathname.slice("/__cs/ui/".length)
    if (!name || name.includes("..")) return sendText(res, 400, "bad asset path")
    return serveUi(res, name)
  }

  if (pathname === "/__cs/events") return sse.attach(req, res)

  if (pathname === "/__cs/mcp") {
    if (!mcp) return sendText(res, 501, "contactsheet: MCP 模块未就绪")
    return mcp(req, res)
  }

  if (pathname.startsWith("/__cs/api/")) return handleApi(cfg, req, res, pathname)

  // 其余一切放行给代理,包括注入路由 /__cs/ab/* 、/__cs/registry 、/__cs/tokens
  proxy.web(req, res)
}

function serveUi(res: http.ServerResponse, name: string): void {
  const file = findUiFile(name)
  if (!file) return sendText(res, 404, `contactsheet: 找不到画布资产 ${name},先跑 node build.mjs`)
  let body = fs.readFileSync(file)
  // 画布页(且只有画布页)拿到本次进程的 push token。iframe 里跑的用户页面拿不到它,
  // 所以就算 app 里混进第三方脚本,也没法冒用你的名义向 Claude Code 会话说话。
  if (name === "index.html") {
    body = Buffer.from(
      body.toString("utf8").replace("</head>", `<meta name="cs-token" content="${pushToken()}" />\n</head>`)
    )
  }
  res.writeHead(200, { "content-type": mimeOf(file), "cache-control": "no-store" })
  res.end(body)
}

/** 供 MCP 用的只读服务面 */
function makeServices(cfg: CsConfig): McpServices {
  return {
    // registry 由注入进用户 app 的路由提供,直连 target(node fetch 不走系统代理)
    async getRegistry(): Promise<RegistryEntry[]> {
      try {
        const r = await fetch(`${cfg.target}/__cs/registry`)
        if (!r.ok) return []
        const data: unknown = await r.json()
        return Array.isArray(data) ? (data as RegistryEntry[]) : []
      } catch {
        return [] // next dev 没起
      }
    },
    getSelection: () => store.getSelection(),
    getAnnotations: () => store.readAnnotations(cfg),
    takeShot: async (req) => screenshot(cfg, req),
  }
}

function downPage(target: string): string {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>contactsheet</title>
<body style="font:14px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;padding:48px;color:#333;background:#fafafa">
<h1 style="font-size:15px;margin:0 0 12px">contactsheet:目标 ${escapeHtml(target)} 未启动</h1>
<p style="margin:0 0 8px">先在项目里跑 <code>next dev</code>,再刷新本页。</p>
<p style="margin:0"><a href="/__cs" style="color:#06c">← 回画布</a></p>
</body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string)
}
