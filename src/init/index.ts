// [Agent E] contactsheet init —— 把 contactsheet 接到一个已有的 Next.js 项目上
// 铁律:所有 JSON 都是合并写入,用户已有的内容一个字都不能丢;看不懂的文件宁可中止也不覆盖。
// 只用 node 内建。

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import type { CsConfig } from "../types.js"

const DEFAULT_TARGET = "http://localhost:3000"
const DEFAULT_PORT = 5199
const DEFAULT_DESIGN_DIR = "design"

/** 用户项目里 shadcn 组件的常见落点,按顺序探测 */
const UI_DIR_CANDIDATES = ["components/ui", "src/components/ui"]

// ============================================================
// 入口
// ============================================================

export async function runInit(cwd: string, flags: Partial<CsConfig>): Promise<void> {
  const root = resolve(cwd)

  // a. 必须是个 Next.js 项目
  assertNextProject(root)

  // b. 探测 appDir + 写配置
  const appDir = detectAppDir(root)
  const cfg = writeConfigFile(root, appDir, flags)
  console.log(`contactsheet init —— ${root}`)
  console.log(`  app 目录:${cfg.appDir}`)
  console.log(`  配置:contactsheet.config.json(target ${cfg.target},port ${cfg.port},画板目录 ${cfg.designDir})`)

  // c. .gitignore 由注入器(contactsheet 运行时)负责,init 不碰

  // d. 自动铺画板
  seedArtboards(root, cfg.designDir)

  // e. .mcp.json
  writeMcpJson(root, cfg.port)

  // f. .claude/settings.json 的 UserPromptSubmit hook
  writeClaudeHook(root, cfg.port)

  // g. 下一步
  console.log("")
  console.log("下一步:")
  console.log("  1. 照常起你自己的 dev server(next dev),确认它在 " + cfg.target)
  console.log("  2. 另开一个终端:npx contactsheet")
  console.log(`  3. 打开 http://localhost:${cfg.port}/__cs`)
  console.log("")
  console.log("端口都可以换:dev server 不在 " + cfg.target + " 就 --target <url>,")
  console.log(`  ${cfg.port} 被占就 --port <n>(或改 contactsheet.config.json 后重跑 init,MCP/hook 会跟着换)。`)
  console.log(`  ${cfg.port} 被别的进程占着时,contactsheet 会自动顺延到下一个空闲端口并提示。`)
}

// ============================================================
// a. Next 项目校验
// ============================================================

function assertNextProject(root: string): void {
  const pkgPath = join(root, "package.json")
  if (!existsSync(pkgPath)) {
    throw new Error(
      `contactsheet init 中止:${root} 下没有 package.json。\n` +
        `contactsheet 是附着在你自己的 Next.js 项目上跑的,请到项目根目录再执行一次。`,
    )
  }
  const pkg = readJsonObject(pkgPath) ?? {}
  const deps = { ...asRecord(pkg["dependencies"]), ...asRecord(pkg["devDependencies"]) }
  if (!("next" in deps)) {
    throw new Error(
      `contactsheet init 中止:${pkgPath} 的 dependencies / devDependencies 里没有 next。\n` +
        `contactsheet v1 只认 Next.js App Router 项目 —— 它靠往你的 app 目录注入一条画板路由干活,\n` +
        `渲染后端就是你自己的 next dev,没有 Next 就没有画板。`,
    )
  }
}

// ============================================================
// b. appDir 探测 + 配置文件
// ============================================================

/** src/app 优先于 app;都没有说明不是 App Router 项目 */
function detectAppDir(root: string): string {
  for (const candidate of ["src/app", "app"]) {
    if (isDir(join(root, candidate))) return candidate
  }
  throw new Error(
    `contactsheet init 中止:${root} 下既没有 src/app/ 也没有 app/。\n` +
      `contactsheet v1 只支持 App Router(画板路由要注入到 app 目录里)。Pages Router 项目暂时用不了。`,
  )
}

/** 从 package.json 的 dev script 里认端口(next dev -p 3100 / --port 3100 / PORT=3100),
 *  认出来非 3000 就当默认 target —— 用户跑的本来就不是 3000 时,别再让他手改配置 */
function detectDevTarget(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>
    }
    const dev = pkg.scripts?.["dev"] ?? ""
    const m = dev.match(/(?:-p|--port)[ =](\d{2,5})/) ?? dev.match(/\bPORT=(\d{2,5})/)
    if (m && m[1] !== "3000") return `http://localhost:${m[1]}`
  } catch {
    /* 读不到就用默认 */
  }
  return null
}

function writeConfigFile(root: string, appDir: string, flags: Partial<CsConfig>): CsConfig {
  const file = join(root, "contactsheet.config.json")
  const existing = readJsonObject(file) ?? {}

  // 优先级:CLI flags > 用户已有配置 > 探测/默认值。用户手改过的值不会被 init 抹掉。
  const resolved = {
    target: pickString(flags.target, existing["target"], detectDevTarget(root) ?? DEFAULT_TARGET),
    port: pickNumber(flags.port, existing["port"], DEFAULT_PORT),
    appDir: pickString(flags.appDir, existing["appDir"], appDir),
    designDir: pickString(flags.designDir, existing["designDir"], DEFAULT_DESIGN_DIR),
  }

  // 展开 existing 在前:用户加的额外字段原样保留,键顺序也稳定(重复跑 init 内容不变)
  writeJsonFile(file, { ...existing, ...resolved })

  return { projectRoot: root, ...resolved }
}

// ============================================================
// d. 自动铺画板
// ============================================================

function seedArtboards(root: string, designDir: string): void {
  const uiDir = UI_DIR_CANDIDATES.map((p) => join(root, p)).find(isDir)
  if (!uiDir) {
    console.log(`  画板:没找到 components/ui/,跳过自动铺画板(手写 ${designDir}/*.artboard.tsx 一样用)`)
    return
  }

  const files = readdirSync(uiDir)
    .filter((f) => f.endsWith(".tsx"))
    .sort()
  const targetDir = join(root, designDir)

  let created = 0
  let skipped = 0
  let unreadable = 0

  for (const base of files) {
    const componentFile = join(uiDir, base)
    const name = firstComponentExport(readFileSync(componentFile, "utf8"))
    if (!name) {
      unreadable++
      continue
    }
    const artboard = join(targetDir, `${name}.artboard.tsx`)
    if (existsSync(artboard)) {
      skipped++
      continue
    }
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(artboard, artboardTemplate(name, importPathFor(root, designDir, componentFile)), "utf8")
    created++
  }

  console.log(`  画板:铺了 ${created} 块画板,跳过 ${skipped} 个已存在` + (unreadable ? `,${unreadable} 个文件没认出组件导出` : ""))
}

/**
 * 取文件里出现位置最靠前的 PascalCase 导出。
 * 认三种写法:export const X / export function X / export { X, Y }(含跨行与 as 重命名)。
 * v1 接受这个正则的局限 —— 认错了就手改生成出来的画板文件。
 */
function firstComponentExport(source: string): string | null {
  const hits: Array<{ index: number; name: string }> = []

  const declRe = /^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm
  for (const m of source.matchAll(declRe)) {
    if (isPascal(m[1]!)) hits.push({ index: m.index ?? 0, name: m[1]! })
  }

  const listRe = /^export\s*\{([^}]*)\}/gm
  for (const m of source.matchAll(listRe)) {
    for (const raw of m[1]!.split(",")) {
      const item = raw.trim()
      if (!item || item.startsWith("type ")) continue
      // `A as B` 对外导出的是 B
      const parts = item.split(/\s+as\s+/)
      const name = parts[parts.length - 1]!.trim()
      if (isPascal(name)) {
        hits.push({ index: m.index ?? 0, name })
        break
      }
    }
  }

  if (hits.length === 0) return null
  hits.sort((a, b) => a.index - b.index)
  return hits[0]!.name
}

function isPascal(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_$]*$/.test(name)
}

/** 有 @/* alias 且组件确实在 alias 指向的目录下才用 alias,否则老实用相对路径 */
function importPathFor(root: string, designDir: string, componentFile: string): string {
  const aliasBase = readAliasBase(root)
  if (aliasBase && toPosix(componentFile).startsWith(toPosix(aliasBase) + "/")) {
    return "@/" + toPosix(relative(aliasBase, componentFile)).replace(/\.tsx$/, "")
  }
  const rel = toPosix(relative(join(root, designDir), componentFile)).replace(/\.tsx$/, "")
  return rel.startsWith(".") ? rel : "./" + rel
}

/** 读 tsconfig.json 的 paths["@/*"],返回它指向的绝对目录;没配(或 tsconfig 解析不动)→ null,走相对路径 */
function readAliasBase(root: string): string | null {
  const file = join(root, "tsconfig.json")
  if (!existsSync(file)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
  const paths = asRecord(asRecord(asRecord(parsed)["compilerOptions"])["paths"])
  const entry = paths["@/*"]
  const first = Array.isArray(entry) ? entry[0] : undefined
  if (typeof first !== "string") return null
  return resolve(root, first.replace(/\/?\*$/, ""))
}

function artboardTemplate(name: string, importPath: string): string {
  return (
    `// contactsheet 自动生成的画板骨架 —— 随便改,init 不会再覆盖它\n` +
    `import { ${name} } from '${importPath}'\n` +
    `\n` +
    `export const 默认 = {\n` +
    `  render: () => <${name}>示例</${name}>,\n` +
    `}\n`
  )
}

// ============================================================
// e. .mcp.json
// ============================================================

function writeMcpJson(root: string, port: number): void {
  const file = join(root, ".mcp.json")
  const doc = readJsonObject(file) ?? {}
  const servers = asRecord(doc["mcpServers"])
  const had = "contactsheet" in servers

  servers["contactsheet"] = { type: "http", url: `http://localhost:${port}/__cs/mcp` }
  doc["mcpServers"] = servers
  writeJsonFile(file, doc)

  const others = Object.keys(servers).filter((k) => k !== "contactsheet").length
  console.log(
    `  .mcp.json:${had ? "更新" : "写入"} mcpServers.contactsheet` + (others ? `(另外 ${others} 个 server 原样保留)` : ""),
  )
}

// ============================================================
// f. .claude/settings.json 的 UserPromptSubmit hook
// ============================================================

function writeClaudeHook(root: string, port: number): void {
  const file = join(root, ".claude", "settings.json")
  const doc = readJsonObject(file) ?? {}
  const hooks = asRecord(doc["hooks"])
  const list = Array.isArray(hooks["UserPromptSubmit"]) ? (hooks["UserPromptSubmit"] as unknown[]) : []

  // 幂等:已经有一条会去打 /__cs/api/context 的 command 就不再加
  const existingCommands: string[] = []
  for (const group of list) {
    for (const h of Array.isArray(asRecord(group)["hooks"]) ? (asRecord(group)["hooks"] as unknown[]) : []) {
      const cmd = asRecord(h)["command"]
      if (typeof cmd === "string") existingCommands.push(cmd)
    }
  }
  const already = existingCommands.filter((c) => c.includes("/__cs/api/context"))
  if (already.length > 0) {
    console.log(`  .claude/settings.json:context hook 已存在,不重复添加`)
    if (!already.some((c) => c.includes(`localhost:${port}/`))) {
      console.log(`    注意:已有的 hook 打的不是 :${port},端口换过的话请手改这条 command`)
    }
    return
  }

  const command = `curl -s --noproxy '*' --max-time 1 http://localhost:${port}/__cs/api/context || true`
  list.push({ hooks: [{ type: "command", command }] })
  hooks["UserPromptSubmit"] = list
  doc["hooks"] = hooks
  writeJsonFile(file, doc)
  console.log(`  .claude/settings.json:加了 UserPromptSubmit hook(自动把批注和选中元素带给 Claude)`)
}

// ============================================================
// 小工具
// ============================================================

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function toPosix(p: string): string {
  return p.split("\\").join("/")
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function pickString(...candidates: unknown[]): string {
  for (const c of candidates) if (typeof c === "string" && c !== "") return c
  return ""
}

function pickNumber(...candidates: unknown[]): number {
  for (const c of candidates) if (typeof c === "number" && Number.isFinite(c)) return c
  return 0
}

/** 读 JSON 对象;文件不存在 → null;内容不是合法 JSON 对象 → 中止(绝不覆盖) */
function readJsonObject(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null
  const raw = readFileSync(file, "utf8")
  if (raw.trim() === "") return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `contactsheet init 中止:${file} 不是合法的 JSON(${(err as Error).message})。\n` +
        `init 只会往里合并、不会重写,所以看不懂的文件一律不动 —— 请先修好它再跑一次。`,
    )
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`contactsheet init 中止:${file} 的顶层不是一个 JSON 对象,init 不动它。`)
  }
  return parsed as Record<string, unknown>
}

function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8")
}
