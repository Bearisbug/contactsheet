// [Agent D] 截图模块 —— playwright-core 驱动本机 Edge(headless),浏览器实例懒启动+复用
// 单板:开注入的画板路由截全页;整墙:开外壳画布截视口。产物落 <designDir>/.canvas/shots/
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium } from "playwright-core"
import type { Browser } from "playwright-core"
import type { CsConfig, RegistryEntry, ShotRequest, ShotResult } from "../types.js"

/** 空闲多久自动关浏览器 */
const IDLE_MS = 60_000
/** 导航超时;networkidle 在 next dev 下偶尔等不到,超时后照常截图 */
const NAV_TIMEOUT_MS = 30_000

let browserPromise: Promise<Browser> | null = null
let idleTimer: NodeJS.Timeout | null = null

/** 懒启动 + 复用同一个浏览器实例;启动失败不缓存,下次调用重试 */
async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ channel: "msedge", headless: true }).catch((err: unknown) => {
      browserPromise = null
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `contactsheet: 启动 Microsoft Edge 失败(playwright-core channel=msedge)。请确认本机装了 Edge。原始错误:${msg}`
      )
    })
  }
  return browserPromise
}

/** 每次截完重置 60s 空闲计时器 */
function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    void closeBrowser()
  }, IDLE_MS)
  // 别因为这个计时器拖住进程退出
  idleTimer.unref?.()
}

/** 关浏览器,幂等;CLI 退出钩子调 */
export async function closeBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const pending = browserPromise
  browserPromise = null
  if (!pending) return
  try {
    const browser = await pending
    await browser.close()
  } catch {
    // 启动本来就失败 / 已经关掉:忽略
  }
}

export interface CaptureOptions {
  url: string
  width: number
  height: number
  /** true = 截全页,false = 只截视口 */
  fullPage: boolean
  /** 导航完成后额外静置毫秒数 */
  settleMs: number
}

/**
 * 内部能力:开一个新 context 打开 url 并截图,返回 PNG buffer。
 * 不属于对外契约,导出只为 selftest 直接调用。
 */
export async function captureUrl(opts: CaptureOptions): Promise<Buffer> {
  const browser = await getBrowser()
  const context = await browser.newContext({ viewport: { width: opts.width, height: opts.height } })
  try {
    const page = await context.newPage()
    try {
      await page.goto(opts.url, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS })
    } catch {
      // next dev 的长连接可能让 networkidle 等不到:退而求其次,等 DOM 就绪后照常截
      await page.waitForLoadState("domcontentloaded").catch(() => {})
    }
    if (opts.settleMs > 0) await page.waitForTimeout(opts.settleMs)
    return await page.screenshot({ fullPage: opts.fullPage, type: "png" })
  } finally {
    await context.close()
    scheduleIdleClose()
  }
}

/** 取 Next 侧注册表(node fetch 不走系统代理,不用额外处理) */
async function fetchRegistry(cfg: CsConfig): Promise<RegistryEntry[]> {
  const url = `${cfg.target.replace(/\/+$/, "")}/__cs/registry`
  let res: Response
  try {
    res = await fetch(url)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `contactsheet: 读不到注册表 ${url}。确认你的 next dev 正在跑,并且 contactsheet 已注入路由(在项目里跑 npx contactsheet)。原始错误:${msg}`
    )
  }
  if (!res.ok) {
    throw new Error(
      `contactsheet: 注册表 ${url} 返回 ${res.status}。注入路由可能没生效,重跑 npx contactsheet 让它重写注入文件。`
    )
  }
  return (await res.json()) as RegistryEntry[]
}

/** 文件名里去掉路径分隔符等不安全字符(id 形如 "sub__Button.artboard--默认") */
function safeFileName(id: string): string {
  return id.replace(/[/\\:*?"<>|]/g, "_")
}

/** PNG 尺寸直接读 IHDR */
function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** 落盘到 <projectRoot>/<designDir>/.canvas/shots/<name>.png,返回 repo 相对路径 */
async function save(cfg: CsConfig, name: string, buf: Buffer): Promise<string> {
  const file = `${safeFileName(name)}.png`
  const abs = path.join(cfg.projectRoot, cfg.designDir, ".canvas", "shots", file)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, buf)
  return `${cfg.designDir.split(path.sep).join("/").replace(/\/+$/, "")}/.canvas/shots/${file}`
}

export async function screenshot(cfg: CsConfig, req: ShotRequest): Promise<ShotResult> {
  let buf: Buffer
  let name: string

  if (req.id) {
    const entries = await fetchRegistry(cfg)
    const entry = entries.find(e => e.id === req.id)
    if (!entry) {
      const known = entries.slice(0, 10).map(e => e.id).join(", ")
      throw new Error(
        `contactsheet: 注册表里没有画板 "${req.id}"。已知 id:${known || "(空)"}${entries.length > 10 ? " …" : ""}`
      )
    }
    const base = `http://localhost:${cfg.port}`
    let url: string
    if (entry.kind === "screen") {
      url = `${base}${entry.url ?? "/"}`
    } else {
      url = `${base}/__cs/ab/${encodeURIComponent(entry.id)}`
      if (req.args) url += `?args=${encodeURIComponent(JSON.stringify(req.args))}`
    }
    buf = await captureUrl({
      url,
      width: entry.env?.width ?? 480,
      height: 900,
      fullPage: true,
      settleMs: 50,
    })
    name = entry.id
  } else {
    // 整面墙:画布本身,固定大视口,给懒挂载的 iframe 留出加载时间
    buf = await captureUrl({
      url: `http://localhost:${cfg.port}/__cs`,
      width: 2400,
      height: 1350,
      fullPage: false,
      settleMs: 3000,
    })
    name = "wall"
  }

  const relPath = await save(cfg, name, buf)
  const { width, height } = pngSize(buf)
  return { path: relPath, base64: buf.toString("base64"), width, height }
}
