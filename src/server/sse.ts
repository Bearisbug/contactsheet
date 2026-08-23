// SSE hub —— 模块级单例。startServer 的返回值签名冻结,推事件走这里导出的 broadcast
import type { IncomingMessage, ServerResponse } from "node:http"
import type { CsEvent } from "../types.js"

const clients = new Set<ServerResponse>()
let heartbeat: NodeJS.Timeout | null = null

/** 挂一个 SSE 客户端(GET /__cs/events) */
export function attach(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  res.write(": contactsheet connected\n\n")
  clients.add(res)

  // 断开就清引用,没人了就停心跳
  const drop = () => {
    clients.delete(res)
    if (clients.size === 0) stopHeartbeat()
  }
  req.on("close", drop)
  req.on("error", drop)
  res.on("close", drop)

  startHeartbeat()
}

/** 推一条事件:事件名 = type,data = 整个 CsEvent 的 JSON */
export function broadcast(ev: CsEvent): void {
  const chunk = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
  for (const res of clients) {
    try {
      res.write(chunk)
    } catch {
      clients.delete(res)
    }
  }
}

/** 退出时断开全部客户端(否则 server.close 永远等不到) */
export function closeAll(): void {
  for (const res of clients) {
    try {
      res.end()
    } catch {
      // 已经断了,无所谓
    }
  }
  clients.clear()
  stopHeartbeat()
}

function startHeartbeat(): void {
  if (heartbeat) return
  // 15s 一条注释行,防中间层掐掉空闲连接
  heartbeat = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n")
  }, 15000)
  heartbeat.unref()
}

function stopHeartbeat(): void {
  if (!heartbeat) return
  clearInterval(heartbeat)
  heartbeat = null
}
