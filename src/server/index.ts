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
import { cyan, dim, link, warn } from "../term.js"
import * as sse from "./sse.js"
import * as store from "./store.js"

// SSE hub 是模块级的(startServer 的返回值签名冻结,推事件只能走这个额外导出)
export { broadcast } from "./sse.js"

type McpHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>

export async function startServer(cfg: CsConfig): Promise<{ port: number; close(): Promise<void> }> {
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
  let twin: http.Server | null = null
  const port = await listenWithFallback(server, cfg, host, (t) => {
    twin = t
    // 孪生的连接同样要进追踪表,否则 Ctrl-C 会卡在它的 keep-alive 上
    t.on("connection", (sock) => {
      sockets.add(sock)
      sock.on("close", () => sockets.delete(sock))
    })
  })
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.warn(
      warn(`监听在 ${host}:${port} —— 画布无鉴权,同网络的任何人都能读你的批注、并向你的 Claude Code 会话推送消息。只在可信网络这么做。`)
    )
  }

  return {
    port,
    async close() {
      sse.closeAll()
      proxyLog.close()
      proxy.close()
      if (twin) {
        await new Promise<void>((r) => twin!.close(() => r()))
      }
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

/** 占着配置端口的是不是"本项目的另一个 contactsheet"?是就没必要再起一个 */
async function occupiedBySameProject(cfg: CsConfig, port: number): Promise<boolean> {
  try {
    const ctl = AbortSignal.timeout(800)
    const r = await fetch(`http://127.0.0.1:${port}/__cs/api/state`, { signal: ctl })
    if (!r.ok) return false
    const data = (await r.json()) as { projectRoot?: string }
    return data?.projectRoot === cfg.projectRoot
  } catch {
    return false
  }
}

/**
 * 端口被占时的策略:
 * - 占用者是本项目的另一个 contactsheet → 打印地址直接退出(用户多半是忘了已经起过);
 * - 用户显式 --port → 不猜,报错说清楚;
 * - 其余(默认/config 端口被别的进程占)→ 往上顺延找空位,最多 20 个,并醒目警告:
 *   换端口 = 换源,画布的本机记忆(画板位置/折叠/底色)按源隔离,MCP 与 hook 也仍指向旧端口。
 */
async function listenWithFallback(
  server: http.Server,
  cfg: CsConfig,
  host: string,
  onTwin: (t: http.Server) => void
): Promise<number> {
  const listenOnce = (srv: http.Server, port: number, h: string): Promise<"ok" | "busy" | "nofam"> =>
    new Promise((resolve, reject) => {
      const onErr = (err: NodeJS.ErrnoException): void => {
        if (err.code === "EADDRINUSE") resolve("busy")
        // 机器没启 IPv6 时 ::1 绑不了,不算冲突
        else if (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT") resolve("nofam")
        else reject(err)
      }
      srv.once("error", onErr)
      srv.listen(port, h, () => {
        srv.off("error", onErr)
        resolve("ok")
      })
    })

  /**
   * 一个端口要 127.0.0.1 和 ::1 **都**绑上才算真的空闲。
   * 浏览器解析 localhost 普遍优先 ::1:只绑 v4 时,若 v6 侧被别人占着(实测 Docker 常年
   * 端口转发在 IPv6 通配上),curl 一切正常、浏览器却拿到对方的 502/空响应 —— 这类"半瞎"
   * 冲突必须当成端口被占处理。::1 上起的是共享同一 handler 的孪生 server。
   * 用户显式指定了非回环 host(LAN)时不做孪生:绑的已经不是 localhost 这个名字了。
   */
  const tryListen = async (port: number): Promise<boolean> => {
    const main = await listenOnce(server, port, host)
    if (main !== "ok") return false
    if (host !== "127.0.0.1") return true
    const t = http.createServer(server.listeners("request")[0] as http.RequestListener)
    for (const l of server.listeners("upgrade")) t.on("upgrade", l as (...a: unknown[]) => void)
    const r = await listenOnce(t, port, "::1")
    if (r === "ok") {
      onTwin(t)
      return true
    }
    if (r === "nofam") return true // 没有 IPv6,单栈即可
    // v6 被别人占:这个端口对浏览器是坏的,整体让出去重试下一个
    await new Promise<void>((res) => server.close(() => res()))
    return false
  }

  if (await tryListen(cfg.port)) return cfg.port

  if (await occupiedBySameProject(cfg, cfg.port)) {
    console.log(
      `${cyan("●")} 本项目已经有一个 contactsheet 在跑了,直接用它:${link(`http://localhost:${cfg.port}/__cs`)}`
    )
    process.exit(0)
  }
  if (cfg.portExplicit) {
    throw new Error(
      `端口 ${cfg.port} 被其他进程占用。换一个 --port,或找出占用者:lsof -nP -iTCP:${cfg.port} -sTCP:LISTEN`
    )
  }
  for (let p = cfg.port + 1; p <= cfg.port + 20; p++) {
    if (await tryListen(p)) {
      console.warn(
        warn(`端口 ${cfg.port} 被占,已顺延到 ${p} → `) + link(`http://localhost:${p}/__cs`) + "\n" +
          dim(`   注意:换端口 = 换浏览器源。画板位置/折叠/底色这些本机记忆按源隔离,这个端口下是全新的;\n`) +
          dim(`   .mcp.json 与 hook 仍指向 ${cfg.port}。想要稳定,请释放 ${cfg.port},或改 config 的 port 后重跑 npx contactsheet init。`)
      )
      return p
    }
  }
  throw new Error(`从 ${cfg.port} 往上连试 20 个端口都被占,用 --port 指定一个空闲端口`)
}
