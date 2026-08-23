// [Agent D] shot 模块自测:node src/shot/selftest.mjs
// Node >= 22 直接跑 .ts(运行时类型擦除),不需要先 build。
// 覆盖:data: URL 直截、注册表 component 分支、screen 分支、整墙分支、两种错误提示。
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const { captureUrl, screenshot, closeBrowser } = await import("./index.ts")

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const results = []
function ok(name) {
  results.push(name)
  console.log("  ok  " + name)
}

/** 假的 next dev:提供 /__cs/registry、画板路由、页面路由、画布首页 */
const ENTRIES = [
  {
    id: "demo.artboard--默认",
    file: "design/demo.artboard.tsx",
    exportName: "默认",
    kind: "component",
    args: { label: "保存" },
    env: { width: 320 },
  },
  {
    id: "screens.artboard--仪表盘",
    file: "design/screens.artboard.ts",
    exportName: "仪表盘",
    kind: "screen",
    url: "/dashboard",
    env: { width: 600 },
  },
]

const seen = []
const fake = createServer((req, res) => {
  seen.push(req.url)
  const pathname = req.url.split("?")[0]
  if (pathname === "/__cs/registry") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(ENTRIES))
    return
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  // 高 1200 的内容,用来验证 fullPage 真的截了整页
  res.end(
    "<!doctype html><meta charset=utf-8><body style='margin:0'>" +
      "<div style='height:1200px;background:linear-gradient(#eee,#333)'>" +
      pathname +
      "</div></body>"
  )
})
await new Promise(resolve => fake.listen(0, "127.0.0.1", resolve))
const port = fake.address().port

const projectRoot = await mkdtemp(path.join(tmpdir(), "cs-shot-selftest-"))
const cfg = {
  projectRoot,
  target: "http://localhost:" + port,
  port,
  appDir: "app",
  designDir: "design",
}

let failed = false
try {
  console.log("shot selftest:")

  // 1. 直接截一个 data: URL
  const buf = await captureUrl({
    url: "data:text/html,<h1>hi</h1>",
    width: 400,
    height: 300,
    fullPage: true,
    settleMs: 0,
  })
  assert.ok(buf.subarray(0, 4).equals(PNG_MAGIC), "不是 PNG")
  assert.ok(buf.readUInt32BE(16) > 0 && buf.readUInt32BE(20) > 0, "PNG 尺寸为 0")
  await (await import("node:fs/promises")).writeFile("/tmp/cs-shot-selftest.png", buf)
  ok(`captureUrl(data:) -> ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)} /tmp/cs-shot-selftest.png`)

  // 2. component 画板:走注册表 + /__cs/ab/<id>,带 args,截全页
  const shot = await screenshot(cfg, { id: ENTRIES[0].id, args: { label: "改过" } })
  assert.equal(shot.path, "design/.canvas/shots/demo.artboard--默认.png")
  assert.equal(shot.width, 320, "viewport 宽应取 env.width")
  assert.ok(shot.height >= 1200, "fullPage 没截到整页,实际高 " + shot.height)
  const onDisk = await readFile(path.join(projectRoot, shot.path))
  assert.ok(onDisk.subarray(0, 4).equals(PNG_MAGIC), "落盘文件不是 PNG")
  assert.equal(onDisk.toString("base64"), shot.base64, "base64 与落盘文件不一致")
  const abReq = seen.find(u => u.startsWith("/__cs/ab/"))
  assert.ok(abReq, "没请求画板路由")
  assert.ok(abReq.includes("args=" + encodeURIComponent(JSON.stringify({ label: "改过" }))), "args 没带上:" + abReq)
  ok(`screenshot(component) -> ${shot.path} ${shot.width}x${shot.height}`)

  // 3. screen 画板:直接开目标 url
  const screenShot = await screenshot(cfg, { id: ENTRIES[1].id })
  assert.equal(screenShot.path, "design/.canvas/shots/screens.artboard--仪表盘.png")
  assert.equal(screenShot.width, 600)
  assert.ok(seen.includes("/dashboard"), "screen 没走目标 url:" + seen.join(" "))
  ok(`screenshot(screen) -> ${screenShot.path} ${screenShot.width}x${screenShot.height}`)

  // 4. 整面墙:2400x1350 视口截图(要等 3s 静置)
  const wall = await screenshot(cfg, {})
  assert.equal(wall.path, "design/.canvas/shots/wall.png")
  assert.equal(wall.width, 2400)
  assert.equal(wall.height, 1350, "整墙应只截视口")
  assert.ok(seen.includes("/__cs"), "整墙没开画布首页")
  ok(`screenshot(wall) -> ${wall.path} ${wall.width}x${wall.height}`)

  // 5. 未知 id 的报错
  await assert.rejects(
    () => screenshot(cfg, { id: "没有这块" }),
    /注册表里没有画板/,
    "未知 id 应报错"
  )
  ok("未知 id -> 报错带已知 id 列表")

  // 6. 取不到注册表的报错要带指引
  const deadCfg = { ...cfg, target: "http://127.0.0.1:1" }
  await assert.rejects(() => screenshot(deadCfg, { id: ENTRIES[0].id }), /next dev/, "注册表不可达应报错")
  ok("注册表不可达 -> 报错带启动指引")
} catch (err) {
  failed = true
  console.error("FAIL:", err)
} finally {
  await closeBrowser()
  // 幂等:再关一次不应抛错
  await closeBrowser()
  await new Promise(resolve => fake.close(resolve))
  await rm(projectRoot, { recursive: true, force: true })
}

console.log(failed ? "shot selftest FAILED" : `shot selftest passed (${results.length} checks)`)
process.exit(failed ? 1 : 0)
