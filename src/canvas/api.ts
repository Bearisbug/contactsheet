// 外壳 API 封装 + SSE 连接。所有路径都在 /__cs 前缀下
import type { Annotation, RegistryEntry, Selection, StateInfo, CsEvent } from "../types.js"

const BASE = "/__cs"

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} → HTTP ${res.status}`)
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
}

export function fetchState(): Promise<StateInfo> {
  return req<StateInfo>(`${BASE}/api/state`)
}

/** registry 由注入到 Next 里的路由提供(外壳直接代理放行) */
export function fetchRegistry(): Promise<RegistryEntry[]> {
  // 必须有超时:目标僵死时这个请求会被吊死,而 boot 串行 await 它 —— 没超时的话
  // 排在后面的一切(SSE/健康恢复)都陪葬。超时走既有的错误卡 + 3 秒重试,冷编译慢也能等到
  return req<RegistryEntry[]>(`${BASE}/registry`, { signal: AbortSignal.timeout(15000) })
}

export function fetchAnnotations(): Promise<Annotation[]> {
  return req<Annotation[]>(`${BASE}/api/annotations`)
}

export function postSelection(sel: Selection): Promise<void> {
  return req<void>(`${BASE}/api/selection`, jsonInit("POST", sel))
}

/** 新建批注:不带 id/createdAt,服务端生成 */
export function createAnnotation(body: {
  artboardId?: string
  anchor?: { selector: string; x: number; y: number }
  text: string
  refs: string[]
  status: "open" | "resolved"
}): Promise<Annotation> {
  return req<Annotation>(`${BASE}/api/annotations`, jsonInit("POST", body))
}

export async function deleteAnnotation(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/annotations/${encodeURIComponent(id)}`, { method: "DELETE" })
  if (!res.ok) throw new Error(`DELETE annotation → HTTP ${res.status}`)
}

export interface PushChooseItem {
  pid: number
  name: string
  status: string
  cwd: string
}
export type PushResponse =
  | { ok: true; pid: number; name: string }
  | { ok: false; reason?: string; choose?: PushChooseItem[] }

/** 一键推送:注入绑定的 Claude Code 会话;多候选时服务端返回 choose 列表让前端出选择器 */
export async function pushContext(pid?: number): Promise<PushResponse> {
  // token 由服务端注入画布页的 <meta>,iframe 里的用户页面拿不到,冒用不了
  const token = document.querySelector<HTMLMetaElement>('meta[name="cs-token"]')?.content ?? ""
  const res = await fetch(`${BASE}/api/push`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cs-token": token },
    body: JSON.stringify(pid !== undefined ? { pid } : {}),
  })
  if (!res.ok) throw new Error(`POST push → HTTP ${res.status}`)
  return res.json() as Promise<PushResponse>
}

/** hook 注入终端用的同一份文本摘要 —— 复制批注按钮直接复用,保证两条通道格式一致 */
export async function fetchContext(): Promise<string> {
  const res = await fetch(`${BASE}/api/context`)
  if (!res.ok) throw new Error(`GET context → HTTP ${res.status}`)
  return res.text()
}

export function patchAnnotation(id: string, patch: Partial<Annotation>): Promise<Annotation> {
  return req<Annotation>(`${BASE}/api/annotations/${encodeURIComponent(id)}`, jsonInit("PATCH", patch))
}

export function postRef(name: string, dataBase64: string): Promise<{ path: string }> {
  return req<{ path: string }>(`${BASE}/api/refs`, jsonInit("POST", { name, dataBase64 }))
}

/** 参考图的取图地址(repo 相对路径 → 外壳 URL)。
 *  ⚠️ 需要外壳补一条 `GET /__cs/api/refs/<repo 相对路径>` 路由(见完成报告);还没有这条路由时
 *  <img> 会 404 —— 缩略图自己会退化成文件名 chip,不会变成破图标。 */
export function refUrl(path: string): string {
  return `${BASE}/api/refs/${path.split("/").map(encodeURIComponent).join("/")}`
}

/** 画板 iframe 的 URL:component 走注入路由,screen 直接走代理到目标页面 */
export function boardUrl(entry: RegistryEntry, args: Record<string, unknown> | null): string {
  if (entry.kind === "screen") return entry.url || "/"
  const base = `${BASE}/ab/${encodeURIComponent(entry.id)}`
  if (!args) return base
  return `${base}?args=${encodeURIComponent(JSON.stringify(args))}`
}

/** 连 SSE:事件名 = CsEvent.type,data = JSON */
export function connectEvents(on: {
  registry(entries: RegistryEntry[]): void
  annotations(list: Annotation[]): void
  health(ok: boolean, detail?: string): void
}): EventSource {
  const es = new EventSource(`${BASE}/events`)
  const dispatch = (raw: unknown) => {
    if (typeof raw !== "string") return
    let ev: CsEvent
    try {
      ev = JSON.parse(raw) as CsEvent
    } catch {
      return
    }
    if (ev.type === "registry") on.registry(ev.entries ?? [])
    else if (ev.type === "annotations") on.annotations(ev.annotations ?? [])
    else if (ev.type === "health") on.health(ev.ok, ev.detail)
  }
  es.addEventListener("registry", (e) => dispatch((e as MessageEvent<string>).data))
  es.addEventListener("annotations", (e) => dispatch((e as MessageEvent<string>).data))
  es.addEventListener("health", (e) => dispatch((e as MessageEvent<string>).data))
  // 没带 event 名的消息也认(data 里有 type)
  es.onmessage = (e) => dispatch(e.data)
  return es
}
