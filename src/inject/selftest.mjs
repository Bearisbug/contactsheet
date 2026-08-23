// ============================================================
// [Agent B] 自测:node src/inject/selftest.mjs
// 造临时假项目 → ensureInjected / regenerateRegistry / watcher / removeInjected
// 跑完删临时目录(finally)。node 不能直接 import 带 ".js" 说明符的 .ts,
// 所以先用 esbuild 把两个模块打成一个临时 mjs 再 import。
// ============================================================
import { existsSync } from "node:fs"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build, transform } from "esbuild"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..")
let projectRootForLog = ""

let passed = 0
function ok(cond, msg) {
  if (!cond) throw new Error("断言失败:" + msg)
  passed++
  console.log("  ✓ " + msg)
}
async function exists(p) {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}
const read = (p) => fs.readFile(p, "utf8")
/** 模板以字符串存放,本仓库 tsc 检查不到,用 esbuild 过一遍语法 */
async function checkSyntax(file, loader) {
  await transform(await read(file), { loader, jsx: "automatic" })
  ok(true, path.relative(projectRootForLog, file) + " 语法可解析")
}
const mtime = async (p) => (await fs.stat(p)).mtimeMs
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "contactsheet-selftest-"))
try {
  // ---- 0. 打包被测模块 ----
  const entry = path.join(tmp, "entry.ts")
  await fs.writeFile(
    entry,
    `export * from ${JSON.stringify(path.join(repoRoot, "src/inject/index.ts"))}\n` +
      `export * from ${JSON.stringify(path.join(repoRoot, "src/watch/index.ts"))}\n`
  )
  const bundle = path.join(tmp, "api.mjs")
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "error" })
  const { ensureInjected, removeInjected, regenerateRegistry, startWatcher } = await import(bundle)

  // ---- 1. 假项目 ----
  const root = path.join(tmp, "proj")
  await fs.mkdir(path.join(root, "app"), { recursive: true })
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fake", dependencies: { next: "16" } }))
  const cfg = {
    projectRoot: root,
    target: "http://localhost:3000",
    port: 5199,
    appDir: "app",
    designDir: "design",
  }
  const P = (...p) => path.join(root, ...p)
  projectRootForLog = root
  const CS = "%5F%5Fcs"

  // ---- 2. ensureInjected ----
  console.log("\n[1] ensureInjected")
  await ensureInjected(cfg)
  const pageFile = P("app", CS, "ab", "[id]", "page.tsx")
  const boundaryFile = P("app", CS, "ab", "[id]", "boundary.tsx")
  const routeFile = P("app", CS, "registry", "route.ts")
  const tokensFile = P("app", CS, "tokens", "page.tsx")
  for (const f of [pageFile, boundaryFile, routeFile, tokensFile]) ok(await exists(f), "存在 " + path.relative(root, f))
  ok(await exists(P("design")), "建了 design/")
  ok(await exists(P("design", ".canvas")), "建了 design/.canvas/")
  ok(await exists(P("design", "__generated__", "registry.tsx")), "顺带生成了空 registry.tsx")

  const page = await read(pageFile)
  ok(page.includes('from "../../../../design/__generated__/registry"'), "page.tsx 的 registry 相对路径(appDir=app)")
  ok(page.includes('id="__cs_meta"'), "page.tsx 带 __cs_meta")
  ok(page.includes("notFound()") && page.includes('process.env.NODE_ENV === "production"'), "page.tsx production notFound")
  ok(page.includes("await props.params") && page.includes("await props.searchParams"), "page.tsx await 了 params/searchParams")
  ok(page.includes("CsErrorBoundary") && page.includes("Suspense"), "page.tsx 包了 ErrorBoundary + Suspense")
  ok(page.includes('kind === "screen"'), "page.tsx 有 screen 分支")
  const boundary = await read(boundaryFile)
  ok(boundary.startsWith("//") && boundary.includes('"use client"'), "boundary.tsx 是 client 组件")
  ok(boundary.includes("getDerivedStateFromError") && boundary.includes("dashed #e5484d"), "boundary.tsx 是红色虚线错误卡")
  const route = await read(routeFile)
  ok(route.includes('from "../../../design/__generated__/registry"'), "route.ts 的 registry 相对路径")
  ok(route.includes("Response.json(entries)") && route.includes("status: 404"), "route.ts 返回 entries / production 404")
  const tokens = await read(tokensFile)
  ok(tokens.includes('"use client"') && tokens.includes("document.styleSheets"), "tokens/page.tsx 枚举 styleSheets")
  ok(tokens.includes("--color-") && tokens.includes("--radius-"), "tokens/page.tsx 分组含色板/圆角")
  for (const [f, s] of [
    ["page", page],
    ["boundary", boundary],
    ["route", route],
    ["tokens", tokens],
  ]) {
    ok(!/loupe/i.test(s), f + " 不含 loupe 字样")
  }

  ok(page.includes("decodeURIComponent"), "page.tsx 自己解码 id(Next 16 的 params 不解百分号转义)")

  // 模板是字符串,本仓库 tsc 看不到,这里用 esbuild 过一遍语法
  console.log("\n[1b] 注入文件语法")
  for (const [f, loader] of [
    [pageFile, "tsx"],
    [boundaryFile, "tsx"],
    [routeFile, "ts"],
    [tokensFile, "tsx"],
    [P("design", "__generated__", "registry.tsx"), "tsx"],
  ]) {
    await checkSyntax(f, loader)
  }

  const gi = await read(P(".gitignore"))
  ok(gi.includes("# contactsheet begin") && gi.includes("# contactsheet end"), ".gitignore 有 contactsheet 块")
  ok(gi.includes("app/%5F%5Fcs/") && gi.includes("design/__generated__/") && gi.includes("design/.canvas/"), ".gitignore 三条路径齐")

  // ---- 3. 幂等 ----
  console.log("\n[2] 幂等(内容相同不重写)")
  const before = await Promise.all([pageFile, routeFile, tokensFile, P(".gitignore")].map(mtime))
  await sleep(15)
  await ensureInjected(cfg)
  const after = await Promise.all([pageFile, routeFile, tokensFile, P(".gitignore")].map(mtime))
  ok(before.every((t, i) => t === after[i]), "二次 ensureInjected 不动 mtime")

  // 已有块整块替换(模板升级场景)
  await fs.writeFile(P(".gitignore"), "node_modules\n\n# contactsheet begin\n旧内容\n# contactsheet end\n\n.env\n")
  await ensureInjected(cfg)
  const gi2 = await read(P(".gitignore"))
  ok(!gi2.includes("旧内容") && gi2.includes("node_modules") && gi2.includes(".env"), "旧块被整块替换,用户内容保留")
  ok(gi2.match(/# contactsheet begin/g).length === 1, "块不重复追加")

  // ---- 4. regenerateRegistry ----
  console.log("\n[3] regenerateRegistry")
  await fs.mkdir(P("design", "forms"), { recursive: true })
  await fs.writeFile(
    P("design", "Button.artboard.tsx"),
    "export const 默认 = { render: (a) => null, args: { size: 'sm' } }\nexport const disabled$2 = { render: () => null }\nconst 私有 = 1\n"
  )
  await fs.writeFile(P("design", "forms", "Login.artboard.ts"), "export const 登录页 = { url: '/login', env: { width: 1440 } }\n")
  await fs.writeFile(P("design", "notes.md"), "不是画板\n")
  await fs.writeFile(P("design", ".canvas", "x.artboard.tsx"), "export const 不该被扫到 = {}\n")

  const entries = await regenerateRegistry(cfg)
  const reg = await read(P("design", "__generated__", "registry.tsx"))
  ok(reg.includes('import * as m0 from "../Button.artboard"'), "registry import 路径:同级文件")
  ok(reg.includes('import * as m1 from "../forms/Login.artboard"'), "registry import 路径:子目录嵌套")
  ok(reg.includes('"Button": m0') && reg.includes('"forms__Login": m1'), 'modules key = fileSlug("/"→"__")')
  ok(reg.includes('"Button": "design/Button.artboard.tsx"'), "files 映射到 repo 相对路径")
  ok(!reg.includes("notes"), "非 artboard 文件不进 registry")
  ok(!reg.includes("不该被扫到") && !reg.includes(".canvas"), ".canvas 被忽略")
  const ids = entries.map((e) => e.id)
  ok(
    JSON.stringify(ids) === JSON.stringify(["Button--默认", "Button--disabled$2", "forms__Login--登录页"]),
    "返回条目 id 正确(含中文/嵌套/$):" + ids.join(", ")
  )
  ok(entries.every((e) => e.kind === "component" && e.args === undefined && e.env === undefined), "kind 一律 component,args/env 留空")
  ok(entries[2].file === "design/forms/Login.artboard.ts" && entries[2].exportName === "登录页", "file/exportName 正确")

  await checkSyntax(P("design", "__generated__", "registry.tsx"), "tsx")

  const regT = await mtime(P("design", "__generated__", "registry.tsx"))
  await sleep(15)
  await regenerateRegistry(cfg)
  ok((await mtime(P("design", "__generated__", "registry.tsx"))) === regT, "内容相同不重写 registry.tsx")

  // ---- 5. appDir = src/app 的相对路径 ----
  console.log("\n[4] appDir = src/app")
  const root2 = path.join(tmp, "proj2")
  await fs.mkdir(path.join(root2, "src", "app"), { recursive: true })
  const cfg2 = { ...cfg, projectRoot: root2, appDir: "src/app", designDir: "design" }
  await ensureInjected(cfg2)
  const page2 = await read(path.join(root2, "src", "app", CS, "ab", "[id]", "page.tsx"))
  ok(page2.includes('from "../../../../../design/__generated__/registry"'), "src/app 深一层 → 多一级 ..")
  const gi3 = await read(path.join(root2, ".gitignore"))
  ok(gi3.includes("src/app/%5F%5Fcs/"), ".gitignore 跟随 appDir")

  // ---- 6. watcher ----
  console.log("\n[5] startWatcher")
  const calls = []
  const w = await startWatcher(cfg, (e) => calls.push(e))
  const waitFor = async (pred, label) => {
    for (let i = 0; i < 60; i++) {
      if (pred()) return true
      await sleep(50)
    }
    throw new Error("等超时:" + label)
  }
  await waitFor(() => calls.length >= 1, "首次回调")
  ok(calls[0].length === 3, "ignoreInitial:false 首次就回调,3 条")
  const n = calls.length
  await fs.writeFile(P("design", "Card.artboard.tsx"), "export const 卡片 = { render: () => null }\n")
  await waitFor(() => calls.length > n, "新增文件后的回调")
  const last = calls[calls.length - 1]
  ok(last.some((e) => e.id === "Card--卡片"), "新增 artboard 出现在回调里")
  ok((await read(P("design", "__generated__", "registry.tsx"))).includes("Card.artboard"), "registry.tsx 已重写")
  const n2 = calls.length
  await fs.rm(P("design", "Card.artboard.tsx"))
  await waitFor(() => calls.length > n2, "删除文件后的回调")
  ok(!calls[calls.length - 1].some((e) => e.id === "Card--卡片"), "删除后条目消失")
  const n3 = calls.length
  await fs.writeFile(P("design", "__generated__", "touch.txt"), "x") // 忽略目录里的动静
  await sleep(500)
  ok(calls.length === n3, "__generated__ 里的变更不触发回调")
  await w.close()
  const n4 = calls.length
  await fs.writeFile(P("design", "After.artboard.tsx"), "export const 关掉后 = { render: () => null }\n")
  await sleep(400)
  ok(calls.length === n4, "close() 之后不再回调")

  // ---- 7. removeInjected ----
  console.log("\n[6] removeInjected")
  await removeInjected(cfg)
  ok(!(await exists(P("app", CS))), "注入目录已删")
  ok(!(await exists(P("design", "__generated__"))), "生成的 registry 已删")
  ok(await exists(P("design", "Button.artboard.tsx")), "用户画板文件保留")
  ok(await exists(P("design", ".canvas")), "design/.canvas 保留")
  const gi4 = await read(P(".gitignore"))
  ok(!gi4.includes("contactsheet") && gi4.includes("node_modules") && gi4.includes(".env"), ".gitignore 块已清,其余保留")
  ok(await exists(P("app")), "用户 app/ 目录本体还在")

  console.log("\n全部通过:" + passed + " 条断言")
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
  console.log("已清理临时目录 " + tmp + (existsSync(tmp) ? "(失败!)" : ""))
}
