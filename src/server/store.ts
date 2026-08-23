// 状态:selection 只在内存,annotations / refs 落盘到 <designDir>/.canvas/
import fs from "node:fs/promises"
import path from "node:path"
import type { Annotation, CsConfig, Selection } from "../types.js"

// ---------- selection(内存态,进程退出即丢) ----------

let selection: Selection | null = null

export function getSelection(): Selection | null {
  return selection
}

export function setSelection(next: Selection | null): void {
  selection = next
}

// ---------- annotations ----------

function canvasDir(cfg: CsConfig): string {
  return path.join(cfg.projectRoot, cfg.designDir, ".canvas")
}

function annotationsFile(cfg: CsConfig): string {
  return path.join(canvasDir(cfg), "annotations.json")
}

/**
 * 读批注。**文件不存在**才是空表;**内容坏了要抛错**——不能把解析失败当成空表,
 * 否则读-改-写会拿这个空数组当基线,下一次钉 pin 就把整份历史永久抹掉。
 * 而 README 明确邀请 Claude Code 手改这个文件,改出结构偏差是常事。
 */
export async function readAnnotations(cfg: CsConfig): Promise<Annotation[]> {
  let raw: string
  try {
    raw = await fs.readFile(annotationsFile(cfg), "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [] // 还没有批注,正常
    throw err
  }
  if (!raw.trim()) return []
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `annotations.json 解析失败(${(err as Error).message})。为避免覆盖历史已拒绝写入——` +
        `请修好 ${annotationsFile(cfg)} 再试。`
    )
  }
  if (!Array.isArray(list)) {
    throw new Error(`annotations.json 顶层不是数组,拒绝写入以免覆盖历史:${annotationsFile(cfg)}`)
  }
  // 旧数据没有 seq:按文件顺序从 max+1 起补(确定性,重启不变号)。
  // 这里只补内存里的,下一次任何写操作会随整表落盘
  const anns = list as Annotation[]
  let next = anns.reduce((m, a) => Math.max(m, a.seq ?? 0), 0)
  for (const a of anns) if (typeof a.seq !== "number") a.seq = ++next
  return anns
}

/** 原子写:临时文件 + rename;覆盖前留一份 .bak(历史是这个工具唯一的持久资产) */
async function writeAnnotations(cfg: CsConfig, list: Annotation[]): Promise<void> {
  const file = annotationsFile(cfg)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.copyFile(file, `${file}.bak`).catch(() => undefined) // 首次写入时没有旧文件,正常
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(list, null, 2) + "\n", "utf8")
  await fs.rename(tmp, file)
}

// 读-改-写串行化,避免并发请求互相覆盖
let chain: Promise<unknown> = Promise.resolve()

/** fn 直接改传入的数组;返回 fn 的结果 + 写盘后的完整表(给 SSE 用) */
export function updateAnnotations<T>(
  cfg: CsConfig,
  fn: (list: Annotation[]) => T
): Promise<{ result: T; list: Annotation[] }> {
  const run = chain.then(async () => {
    const list = await readAnnotations(cfg)
    const result = fn(list)
    await writeAnnotations(cfg, list)
    return { result, list }
  })
  chain = run.catch(() => undefined)
  return run
}

/** id = "a" + 时间戳 36 进制;同毫秒撞了就追加序号 */
export function newAnnotationId(list: Annotation[]): string {
  const base = "a" + Date.now().toString(36)
  let id = base
  for (let n = 1; list.some((a) => a.id === id); n++) id = base + n.toString(36)
  return id
}

// ---------- refs(贴图) ----------

/** 存参考图,返回 repo 相对路径 */
export async function saveRef(cfg: CsConfig, name: string, dataBase64: string): Promise<string> {
  // 只取文件名部分再清洗,防路径穿越(../、绝对路径、奇怪字符全没了)
  const safe = path.basename(name).replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "") || "ref.png"
  const day = new Date().toISOString().slice(0, 10)
  const dir = path.join(canvasDir(cfg), "refs")
  await fs.mkdir(dir, { recursive: true })

  // 同名同日再撞就加序号
  const ext = path.extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)
  let filename = `${day}-${safe}`
  for (let n = 2; await exists(path.join(dir, filename)); n++) filename = `${day}-${stem}-${n}${ext}`

  // 画布 paste 过来的可能带 data URL 头
  const body = dataBase64.replace(/^data:[^;,]*;base64,/, "")
  await fs.writeFile(path.join(dir, filename), Buffer.from(body, "base64"))
  return `${cfg.designDir}/.canvas/refs/${filename}`
}

/** 读参考图。rel 来自 URL,是不可信输入:先 resolve 再比前缀,`..` 已被折叠,拼串骗不过去 */
export async function readRef(cfg: CsConfig, rel: string): Promise<{ body: Buffer; file: string } | null> {
  const root = path.join(canvasDir(cfg), "refs")
  const abs = path.resolve(cfg.projectRoot, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  try {
    return { body: await fs.readFile(abs), file: abs }
  } catch {
    return null // 不存在 / 是目录 / 没权限,对外一律 404
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// ---------- 给终端 hook 的上下文摘要 ----------

/** open 批注 + 当前 selection 的人类可读摘要;都为空返回空串 */
export async function buildContextText(cfg: CsConfig): Promise<string> {
  const open = (await readAnnotations(cfg)).filter((a) => a.status === "open")
  const sel = getSelection()
  if (!sel && open.length === 0) return ""

  const lines = ["## contactsheet 画布上下文"]
  if (sel) {
    lines.push(`当前选中:画板 ${sel.artboardId} · 选择器 \`${sel.selector}\` · 点位 ${fmt(sel.x)},${fmt(sel.y)}`)
  }
  if (open.length > 0) {
    lines.push(`未解决批注(${open.length} 条):`)
    for (const a of open) {
      const where = [a.artboardId, a.anchor?.selector].filter(Boolean).join(" @ ")
      // #seq 与墙上 pin 圆点的数字一致(人说"批注 3"就是它);方括号里的 id 给 PATCH 用
      lines.push(`- #${a.seq} [${a.id}] ${where ? where + " —— " : ""}${a.text}`)
      // 编号与正文里的 [图片 n] 占位符一一对应:Claude 看到 [图片 2] 就去下面找 图片 2 的路径
      ;(a.refs ?? []).forEach((ref, i) => lines.push(`  图片 ${i + 1}:${ref}`))
    }
  }
  return lines.join("\n") + "\n"
}

function fmt(n: number): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "?"
}
