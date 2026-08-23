// 端到端验收:对 spike/fixture-app 真跑整个产品
// 用法:node scripts/e2e.mjs   (要求先 node build.mjs;自己起 next dev 与 contactsheet,跑完自己收)
import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const FIXTURE = path.join(ROOT, "spike/fixture-app")
// 专用端口:5199 可能被用户正在跑的 contactsheet 占着,撞上会把断言打到别人的画布上
const CS = "http://localhost:5641"
const results = []
const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond, extra })
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  — " + extra : ""}`)
}

// node fetch 不走系统代理,无需 --noproxy
async function waitHttp(url, ms = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      await fetch(url)
      return true
    } catch {
      await delay(500)
    }
  }
  return false
}

const procs = []
function run(cmd, args, cwd) {
  const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env })
  p.stdout.on("data", () => {})
  p.stderr.on("data", () => {})
  procs.push(p)
  return p
}

try {
  // 1. 起 fixture 的 next dev
  run("pnpm", ["dev"], FIXTURE)
  ok("next dev 就绪", await waitHttp("http://localhost:3000/"))

  // 2. 起 contactsheet(在 fixture 目录下,像真实用户那样)
  run("node", [path.join(ROOT, "dist/cli.js"), "--port", "5641"], FIXTURE)
  ok("contactsheet 就绪", await waitHttp(`${CS}/__cs/api/state`))

  // 3. 注入产物落盘了吗
  ok("画板路由已注入", fs.existsSync(path.join(FIXTURE, "app/%5F%5Fcs/ab/[id]/page.tsx")))
  ok("registry 已生成", fs.existsSync(path.join(FIXTURE, "design/__generated__/registry.tsx")))
  ok(".gitignore 有 contactsheet 块",
    fs.readFileSync(path.join(FIXTURE, ".gitignore"), "utf8").includes("# contactsheet"))

  // 4. Next 侧 registry(条目数随 fixture 演化,只断言下限,增长测试用相对值)
  const reg = await (await fetch(`${CS}/__cs/registry`)).json()
  const N = reg.length
  ok("registry 条目数≥10", N >= 10, `实际 ${N}`)
  ok("registry 有 screen 类型", reg.some((e) => e.kind === "screen" && e.url === "/dashboard"))
  ok("registry 带默认 args", reg.some((e) => e.args && "disabled" in e.args))

  // 5. 单画板渲染(最难的:async server component)
  const abId = reg.find((e) => e.exportName === "比分卡_异步服务端")?.id
  const abHtml = await (await fetch(`${CS}/__cs/ab/${encodeURIComponent(abId)}`)).text()
  ok("server 画板渲出比分", abHtml.includes("Arsenal"))
  ok("画板带 __cs_meta", abHtml.includes("__cs_meta"))

  // 6. args 覆盖:disabled=true 应渲出 disabled 属性
  const btnId = reg.find((e) => e.exportName === "默认" && e.file.includes("Button"))?.id
  const over = encodeURIComponent(JSON.stringify({ disabled: true }))
  const btnHtml = await (await fetch(`${CS}/__cs/ab/${encodeURIComponent(btnId)}?args=${over}`)).text()
  ok("args 覆盖生效(disabled)", /<button[^>]*disabled/.test(btnHtml))

  // 7. selection / annotations / context 全链路
  const sel = { artboardId: btnId, selector: "button", x: 0.5, y: 0.5, ts: 1 }
  await fetch(`${CS}/__cs/api/selection`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sel) })
  const selBack = await (await fetch(`${CS}/__cs/api/selection`)).json()
  ok("selection 往返", selBack?.selector === "button")

  const annRes = await fetch(`${CS}/__cs/api/annotations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ artboardId: btnId, anchor: { selector: "button", x: 0.5, y: 0.6 }, text: "圆角改小一点", refs: [], status: "open" }) })
  const ann = await annRes.json()
  ok("annotation 创建", !!ann.id)
  // 永久序号:全表 max+1(含 verified),墙上 pin 圆点和推送文本用同一个号
  const allAnns = await (await fetch(`${CS}/__cs/api/annotations`)).json()
  const maxOther = Math.max(0, ...allAnns.filter((a) => a.id !== ann.id).map((a) => a.seq ?? 0))
  ok("annotation 带永久序号", ann.seq === maxOther + 1, `seq=${ann.seq}(其余最大 ${maxOther})`)
  ok("annotations 落盘", fs.existsSync(path.join(FIXTURE, "design/.canvas/annotations.json")))
  const ctx = await (await fetch(`${CS}/__cs/api/context`)).text()
  ok("hook context 含批注", ctx.includes("圆角改小一点"))
  ok("hook context 用 #序号 指认", ctx.includes(`#${ann.seq} [${ann.id}]`))
  ok("hook context 含选中", ctx.includes("button"))

  // 8. MCP:initialize → tools/list → canvas_annotations
  const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" }
  const mcpCall = async (body) => {
    const r = await fetch(`${CS}/__cs/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify(body) })
    const t = await r.text()
    // streamable http 可能回 SSE 格式,取 data: 行
    const m = t.match(/^data: (.*)$/m)
    return JSON.parse(m ? m[1] : t)
  }
  const init = await mcpCall({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } })
  ok("MCP initialize", !!init.result)
  const tools = await mcpCall({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  const names = (tools.result?.tools ?? []).map((t) => t.name).sort()
  ok("MCP 四工具", JSON.stringify(names) === JSON.stringify(["canvas_annotations", "canvas_list", "canvas_screenshot", "canvas_selection"]), names.join(","))
  const annTool = await mcpCall({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "canvas_annotations", arguments: {} } })
  ok("MCP canvas_annotations 读到批注", JSON.stringify(annTool).includes("圆角改小一点"))

  // 9. 截图(playwright + Edge,走 shot 模块)
  const shot = await (await fetch(`${CS}/__cs/api/screenshot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: btnId }) })).json()
  ok("单板截图", shot.path && fs.existsSync(path.join(FIXTURE, shot.path)) && shot.base64?.length > 1000, shot.path)

  // 10. 热更新链:加一个 export → registry 变多
  const bFile = path.join(FIXTURE, "design/Button.artboard.tsx")
  const bOrig = fs.readFileSync(bFile, "utf8")
  fs.writeFileSync(bFile, bOrig + '\nexport const 幽灵 = { render: (a: A) => <Button {...a}>幽灵按钮</Button>, args: { variant: "ghost" } }\n')
  let grew = false
  for (let i = 0; i < 20; i++) {
    await delay(500)
    const r2 = await (await fetch(`${CS}/__cs/registry`)).json()
    if (r2.length === N + 1) { grew = true; break }
  }
  fs.writeFileSync(bFile, bOrig)
  ok("加 export → registry 增长", grew)

  // 10b. 回归(verifier P2-2):漏写 render 的画板不许静默消失,要进注册表出错误卡
  fs.writeFileSync(bFile, bOrig + "\nexport const 忘写render = { args: { x: 1 } }\n")
  let typoEntry = null
  for (let i = 0; i < 20; i++) {
    await delay(500)
    const r3 = await (await fetch(`${CS}/__cs/registry`)).json()
    typoEntry = r3.find((e) => e.exportName === "忘写render")
    if (typoEntry) break
  }
  ok("漏写 render 仍进注册表", !!typoEntry && typoEntry.kind === "component")
  if (typoEntry) {
    const typoHtml = await (await fetch(`${CS}/__cs/ab/${encodeURIComponent(typoEntry.id)}`)).text()
    ok("漏写 render 出错误卡", typoHtml.includes("data-cs-error"))
  } else {
    ok("漏写 render 出错误卡", false, "没等到条目")
  }
  fs.writeFileSync(bFile, bOrig)

  // 清理本次产生的批注与选中,别让 annotations.json 逐次膨胀
  await fetch(`${CS}/__cs/api/annotations/${ann.id}`, { method: "DELETE" })
  await fetch(`${CS}/__cs/api/selection`, { method: "POST", headers: { "content-type": "application/json" }, body: "null" })
  const annLeft = await (await fetch(`${CS}/__cs/api/annotations`)).json()
  ok("测试批注已清理", !annLeft.some((a) => a.id === ann.id))

  // 11. 画布 DOM 冒烟(集成时按 C 的实际 DOM 细化)
  const { chromium } = await import("playwright-core")
  const browser = await chromium.launch({ channel: "msedge", headless: true })
  const page = await browser.newPage({ viewport: { width: 2400, height: 1200 } })
  await page.goto(`${CS}/__cs`, { waitUntil: "networkidle" })
  await delay(3000)
  const iframeCount = await page.evaluate(() => document.querySelectorAll("iframe").length)
  ok("画布挂出画板 iframe", iframeCount >= 5, `${iframeCount} 个`)
  await page.screenshot({ path: "/tmp/cs-e2e-wall.png" })
  await browser.close()
  console.log("\n墙截图: /tmp/cs-e2e-wall.png")
} finally {
  for (const p of procs) p.kill("SIGTERM")
  await delay(1000)
  for (const p of procs) p.kill("SIGKILL")
}

const fails = results.filter((r) => !r.pass)
console.log(`\n===== ${results.length - fails.length}/${results.length} 通过 =====`)
process.exit(fails.length ? 1 : 0)
