// ============================================================
// [Agent B] 注入 / 卸载 Next 侧文件 + 生成画板 registry
// 签名冻结,见 CONTRACTS.md
// ============================================================
import { promises as fs } from "node:fs"
import path from "node:path"
import type { CsConfig, RegistryEntry } from "../types.js"
import {
  boundaryTemplate,
  pageTemplate,
  registryTemplate,
  routeTemplate,
  tokensTemplate,
  type RegistryItem,
} from "./templates.js"

/** 注入路由的文件夹名:App Router 里下划线开头是 private folder,必须写成 %5F 转义,URL 即 /__cs/... */
const CS_DIR = "%5F%5Fcs"

const GITIGNORE_BEGIN = "# contactsheet begin"
const GITIGNORE_END = "# contactsheet end"

/** 配置里的相对路径统一成 posix、无前导 "./"、无尾斜杠 */
function normRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
}

/** 注入根目录(repo 相对,posix) */
function csDirRel(cfg: CsConfig): string {
  return normRel(cfg.appDir) + "/" + CS_DIR
}

/** 从某个注入文件所在目录 import 到 <designDir>/__generated__/registry 的相对说明符 */
function registryImportFrom(fromDirRel: string, cfg: CsConfig): string {
  const target = normRel(cfg.designDir) + "/__generated__/registry"
  const rel = path.posix.relative(fromDirRel, target)
  return rel.startsWith(".") ? rel : "./" + rel
}

async function readOr(file: string, fallback: string | null): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8")
  } catch {
    return fallback
  }
}

/** 内容相同就不写:避免动 mtime 触发 Next 无谓重编译 */
async function writeIfChanged(file: string, content: string): Promise<boolean> {
  if ((await readOr(file, null)) === content) return false
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, "utf8")
  return true
}

/** 定位 .gitignore 里的 contactsheet 块(含首尾标记) */
function findBlock(text: string): { start: number; end: number } | null {
  const start = text.indexOf(GITIGNORE_BEGIN)
  if (start < 0) return null
  const at = text.indexOf(GITIGNORE_END, start)
  if (at < 0) return null
  return { start, end: at + GITIGNORE_END.length }
}

function gitignoreBlock(cfg: CsConfig): string {
  const design = normRel(cfg.designDir)
  return [GITIGNORE_BEGIN, csDirRel(cfg) + "/", design + "/__generated__/", design + "/.canvas/", GITIGNORE_END].join(
    "\n"
  )
}

/** 幂等写 .gitignore:有旧块整块替换(模板升级),没有就追加 */
async function updateGitignore(cfg: CsConfig): Promise<void> {
  const file = path.join(cfg.projectRoot, ".gitignore")
  const old = (await readOr(file, "")) as string
  const block = gitignoreBlock(cfg)
  const found = findBlock(old)
  const next = found
    ? old.slice(0, found.start) + block + old.slice(found.end)
    : (old.trimEnd() ? old.trimEnd() + "\n\n" : "") + block + "\n"
  await writeIfChanged(file, next)
}

async function removeGitignoreBlock(cfg: CsConfig): Promise<void> {
  const file = path.join(cfg.projectRoot, ".gitignore")
  const old = await readOr(file, null)
  if (old === null) return
  const found = findBlock(old)
  if (!found) return
  const left = (old.slice(0, found.start) + old.slice(found.end)).replace(/\n{3,}/g, "\n\n").trimEnd()
  await writeIfChanged(file, left ? left + "\n" : "")
}

/** 写/更新全部注入文件 + gitignore */
export async function ensureInjected(cfg: CsConfig): Promise<void> {
  const root = cfg.projectRoot
  const designAbs = path.join(root, normRel(cfg.designDir))
  await fs.mkdir(designAbs, { recursive: true })
  await fs.mkdir(path.join(designAbs, ".canvas"), { recursive: true })

  const abDirRel = csDirRel(cfg) + "/ab/[id]"
  await writeIfChanged(path.join(root, abDirRel, "page.tsx"), pageTemplate(registryImportFrom(abDirRel, cfg)))
  await writeIfChanged(path.join(root, abDirRel, "boundary.tsx"), boundaryTemplate())

  const routeDirRel = csDirRel(cfg) + "/registry"
  await writeIfChanged(path.join(root, routeDirRel, "route.ts"), routeTemplate(registryImportFrom(routeDirRel, cfg)))

  await writeIfChanged(path.join(root, csDirRel(cfg), "tokens", "page.tsx"), tokensTemplate())

  await updateGitignore(cfg)
  // 先保证 page/route 的 import 目标存在,免得 watcher 首次刷新前打开画板报解析失败
  await regenerateRegistry(cfg)
}

/** clean 命令:删注入目录与生成物,design 下的用户画板不动 */
export async function removeInjected(cfg: CsConfig): Promise<void> {
  await fs.rm(path.join(cfg.projectRoot, csDirRel(cfg)), { recursive: true, force: true })
  await fs.rm(path.join(cfg.projectRoot, normRel(cfg.designDir), "__generated__"), { recursive: true, force: true })
  await removeGitignoreBlock(cfg)
}

/** 递归扫 designDir,返回 *.artboard.{tsx,ts} 的 posix 相对路径 */
async function scanArtboards(designAbs: string, sub = ""): Promise<string[]> {
  let dirents
  try {
    dirents = await fs.readdir(path.join(designAbs, sub), { withFileTypes: true })
  } catch {
    return [] // design 目录不存在
  }
  const out: string[] = []
  for (const d of dirents) {
    const rel = sub ? sub + "/" + d.name : d.name
    if (d.isDirectory()) {
      // 忽略生成物、画布数据(.canvas)与任何隐藏目录
      if (d.name === "__generated__" || d.name === "node_modules" || d.name.startsWith(".")) continue
      out.push(...(await scanArtboards(designAbs, rel)))
    } else if (/\.artboard\.tsx?$/.test(d.name)) {
      out.push(rel)
    }
  }
  return out
}

/** 正则提取 export const 名(v1 接受其局限,见 CONTRACTS) */
function extractExports(source: string): string[] {
  const re = /^export\s+const\s+([\p{L}\w$]+)/gmu
  const names: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    if (!names.includes(m[1])) names.push(m[1])
  }
  return names
}

/** fileSlug:designDir 下相对路径去掉 .artboard.tsx?,"/" → "__" */
function slugOf(rel: string): string {
  return rel.replace(/\.artboard\.tsx?$/, "").replace(/\//g, "__")
}

/** 扫描 + 重写 <designDir>/__generated__/registry.tsx,返回条目(args/env 留 undefined,真值由 Next 侧 route 给) */
export async function regenerateRegistry(cfg: CsConfig): Promise<RegistryEntry[]> {
  const designRel = normRel(cfg.designDir)
  const designAbs = path.join(cfg.projectRoot, designRel)
  const rels = (await scanArtboards(designAbs)).sort()

  const items: RegistryItem[] = []
  const entries: RegistryEntry[] = []
  for (const rel of rels) {
    const source = await readOr(path.join(designAbs, rel), null)
    if (source === null) continue // 扫描后被删,跳过
    const names = extractExports(source)
    if (names.length === 0) continue // 没有 export const 的文件不进 registry
    const slug = slugOf(rel)
    const file = designRel + "/" + rel
    items.push({
      varName: "m" + items.length,
      // registry.tsx 在 <designDir>/__generated__/ 下,上一级就是 designDir
      importPath: "../" + rel.replace(/\.tsx?$/, ""),
      slug,
      file,
    })
    for (const exportName of names) {
      // kind 这里一律 component,screen 由 Next 侧 registry route 按有没有 url 判真值
      entries.push({ id: slug + "--" + exportName, file, exportName, kind: "component" })
    }
  }

  await writeIfChanged(path.join(designAbs, "__generated__", "registry.tsx"), registryTemplate(items))
  return entries
}
