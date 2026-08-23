// /__cs/api/* 的全部处理:state / selection / annotations / refs / context / screenshot
import { randomUUID } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Annotation, CsConfig, Selection, ShotRequest, StateInfo } from "../types.js"
import { screenshot } from "../shot/index.js"
import { mimeOf, pkgVersion } from "./assets.js"
import { pushToSession } from "./push.js"
import { currentHealth } from "./health.js"
import { broadcast } from "./sse.js"
import * as store from "./store.js"

const ANN = "/__cs/api/annotations"

/** 本次进程的 push token:只发给画布页(见 serveUi),iframe 内的用户页面读不到 */
let TOKEN: string | null = null
export function pushToken(): string {
  if (!TOKEN) TOKEN = randomUUID()
  return TOKEN
}

/**
 * 跨源写入闸门。readJson 不看 content-type,所以跨源 fetch 的 POST 属于"简单请求"、
 * 没有预检就能产生副作用——任意网页都能钉批注再调 push,把文本送进你的 Claude Code 会话。
 * 规则:非 GET 必须来自本机画布自身(或不带 Origin 的 curl/脚本)。
 */
function originAllowed(cfg: CsConfig, req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true // curl / node fetch / 同源导航,不是浏览器发起的跨源请求
  const ok = new Set([
    `http://localhost:${cfg.port}`,
    `http://127.0.0.1:${cfg.port}`,
    `http://[::1]:${cfg.port}`,
  ])
  return ok.has(origin)
}

export async function handleApi(
  cfg: CsConfig,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<void> {
  const method = req.method ?? "GET"

  if (method !== "GET" && !originAllowed(cfg, req)) {
    return sendText(res, 403, "contactsheet: 拒绝跨源写入(Origin 不是本机画布)")
  }

  if (pathname === "/__cs/api/state") {
    if (method !== "GET") return sendText(res, 405, "method not allowed")
    const info: StateInfo = {
      version: pkgVersion(),
      target: cfg.target,
      designDir: cfg.designDir,
      projectRoot: cfg.projectRoot,
    }
    return sendJson(res, 200, info)
  }

  if (pathname === "/__cs/api/selection") {
    if (method === "GET") return sendJson(res, 200, store.getSelection())
    if (method === "POST") {
      const body = await readJson<Selection | null>(req)
      // 传 null / 缺 artboardId 都当作清空
      store.setSelection(body && typeof body.artboardId === "string" ? body : null)
      return sendEmpty(res, 204)
    }
    return sendText(res, 405, "method not allowed")
  }

  if (pathname === ANN || pathname.startsWith(ANN + "/")) {
    return handleAnnotations(cfg, req, res, pathname, method)
  }

  // 取图:批注气泡里的缩略图刷新后要能重新拿到字节(内存 dataURL 只活一次会话)
  if (pathname.startsWith("/__cs/api/refs/")) {
    if (method !== "GET") return sendText(res, 405, "method not allowed")
    const rel = pathname.slice("/__cs/api/refs/".length).split("/").map(decodeURIComponent).join("/")
    const hit = await store.readRef(cfg, rel)
    if (!hit) return sendText(res, 404, "contactsheet: 找不到参考图")
    res.writeHead(200, { "content-type": mimeOf(hit.file), "cache-control": "no-store" })
    res.end(hit.body)
    return
  }

  if (pathname === "/__cs/api/refs") {
    if (method !== "POST") return sendText(res, 405, "method not allowed")
    const body = await readJson<{ name?: string; dataBase64?: string }>(req)
    if (!body?.dataBase64) return sendText(res, 400, "缺少 dataBase64")
    const rel = await store.saveRef(cfg, body.name || "ref.png", body.dataBase64)
    return sendJson(res, 200, { path: rel })
  }

  if (pathname === "/__cs/api/health") {
    if (method !== "GET") return sendText(res, 405, "method not allowed")
    return sendJson(res, 200, currentHealth())
  }

  if (pathname === "/__cs/api/context") {
    if (method !== "GET") return sendText(res, 405, "method not allowed")
    // 给 UserPromptSubmit hook 用:没内容就是空 body,hook 那边原样注入即可。
    // 批注文件坏掉时也要 200——让用户在自己的对话里看见这句话,而不是 hook 静默失败
    try {
      return sendText(res, 200, await store.buildContextText(cfg))
    } catch (err) {
      return sendText(res, 200, `[contactsheet] 读批注失败:${errText(err)}`)
    }
  }

  if (pathname === "/__cs/api/push") {
    if (method !== "POST") return sendText(res, 405, "method not allowed")
    // push 是唯一能"以你的名义"向 Claude Code 会话说话的端点,额外要 token
    if (req.headers["x-cs-token"] !== pushToken()) {
      return sendText(res, 403, "contactsheet: 缺少画布 token,拒绝推送(请从画布页操作)")
    }
    const body = await readJson<{ pid?: number }>(req)
    try {
      const text = await store.buildContextText(cfg)
      if (!text.trim()) return sendJson(res, 200, { ok: false, reason: "没有待处理的批注或选中,先按 c 钉一条" })
      return sendJson(res, 200, await pushToSession(cfg, text, body?.pid))
    } catch (err) {
      return sendJson(res, 200, { ok: false, reason: `注入失败:${errText(err)}` })
    }
  }

  if (pathname === "/__cs/api/screenshot") {
    if (method !== "POST") return sendText(res, 405, "method not allowed")
    const body = await readJson<ShotRequest>(req)
    try {
      return sendJson(res, 200, await screenshot(cfg, body ?? {}))
    } catch (err) {
      // shot 模块还是 stub / playwright 起不来,都走这里
      return sendText(res, 500, `screenshot 失败:${errText(err)}`)
    }
  }

  return sendText(res, 404, "not found")
}

async function handleAnnotations(
  cfg: CsConfig,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string
): Promise<void> {
  const id = pathname === ANN ? "" : decodeURIComponent(pathname.slice(ANN.length + 1))

  if (!id && method === "GET") {
    return sendJson(res, 200, await store.readAnnotations(cfg))
  }

  if (!id && method === "POST") {
    const body = await readJson<Partial<Annotation>>(req)
    const { result, list } = await store.updateAnnotations(cfg, (all) => {
      const ann: Annotation = {
        id: store.newAnnotationId(all),
        // 永久序号:全表 max+1,包含 verified 的 —— 号只涨不复用,核验消失也不让后来者顶号
        seq: all.reduce((m, a) => Math.max(m, a.seq ?? 0), 0) + 1,
        artboardId: body?.artboardId,
        anchor: body?.anchor,
        text: typeof body?.text === "string" ? body.text : "",
        refs: Array.isArray(body?.refs) ? body.refs : [],
        status: body?.status === "resolved" ? "resolved" : "open",
        createdAt: new Date().toISOString(),
      }
      all.push(ann)
      return ann
    })
    broadcast({ type: "annotations", annotations: list })
    return sendJson(res, 201, result)
  }

  if (id && method === "PATCH") {
    const patch = await readJson<Partial<Annotation>>(req)
    const { result, list } = await store.updateAnnotations(cfg, (all) => {
      const hit = all.find((a) => a.id === id)
      if (!hit) return null
      // id / createdAt 不给改
      Object.assign(hit, patch, { id: hit.id, createdAt: hit.createdAt })
      return hit
    })
    if (!result) return sendText(res, 404, "annotation not found")
    broadcast({ type: "annotations", annotations: list })
    return sendJson(res, 200, result)
  }

  if (id && method === "DELETE") {
    const { result, list } = await store.updateAnnotations(cfg, (all) => {
      const i = all.findIndex((a) => a.id === id)
      if (i < 0) return false
      all.splice(i, 1)
      return true
    })
    if (!result) return sendText(res, 404, "annotation not found")
    broadcast({ type: "annotations", annotations: list })
    return sendEmpty(res, 204)
  }

  return sendText(res, 405, "method not allowed")
}

// ---------- 小工具 ----------

export function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(body ?? null))
}

export function sendText(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
  res.end(body)
}

function sendEmpty(res: ServerResponse, code: number): void {
  res.writeHead(code)
  res.end()
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString("utf8").trim()
  if (!raw) return null as T
  return JSON.parse(raw) as T
}
