// [Agent D] mcp 模块自测:node src/mcp/selftest.mjs
// Node >= 22 直接跑 .ts(运行时类型擦除)。services 用内存假实现,不依赖浏览器/next。
// 覆盖:initialize -> initialized -> tools/list(4 个)-> 四个工具各调一次 -> 工具抛错 -> GET 405。
import assert from "node:assert/strict"
import { createServer } from "node:http"

const { createMcpHandler } = await import("./index.ts")

/** 1x1 的合法 PNG */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="

const broken = { registry: false }
const services = {
  async getRegistry() {
    if (broken.registry) throw new Error("registry 炸了")
    return [
      {
        id: "demo.artboard--默认",
        file: "design/demo.artboard.tsx",
        exportName: "默认",
        kind: "component",
        args: { label: "保存" },
        env: { width: 320 },
      },
    ]
  },
  getSelection() {
    return { artboardId: "demo.artboard--默认", selector: "button.primary", x: 0.5, y: 0.4, ts: 1 }
  },
  async getAnnotations() {
    return [
      { id: "a1", text: "这里间距太大", refs: [], status: "open", createdAt: "2026-08-22T00:00:00.000Z" },
      { id: "a2", text: "已经改好了", refs: [], status: "resolved", createdAt: "2026-08-21T00:00:00.000Z" },
    ]
  },
  async takeShot(req) {
    return { path: `design/.canvas/shots/${req.id ?? "wall"}.png`, base64: PNG_1X1, width: 1, height: 1 }
  },
}

const handler = createMcpHandler(services)
const server = createServer((req, res) => {
  handler(req, res).catch(err => {
    console.error("handler 抛到外面了:", err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const url = `http://127.0.0.1:${server.address().port}/__cs/mcp`

const results = []
function ok(name) {
  results.push(name)
  console.log("  ok  " + name)
}

let protocolVersion = "2025-06-18"

/** 按 streamable http 规矩发一条 JSON-RPC;响应可能是 SSE,也可能是纯 JSON */
async function post(body, { withVersion = true } = {}) {
  const headers = {
    "content-type": "application/json",
    // 关键:POST 必须同时接受这两种,否则 transport 直接 406
    accept: "application/json, text/event-stream",
  }
  if (withVersion) headers["mcp-protocol-version"] = protocolVersion
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
  const raw = await res.text()
  const ct = res.headers.get("content-type") ?? ""
  let message
  if (ct.includes("text/event-stream")) {
    const data = raw
      .split("\n")
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim())
      .filter(Boolean)
    message = data.length ? JSON.parse(data[data.length - 1]) : undefined
  } else if (raw.trim()) {
    message = JSON.parse(raw)
  }
  return { status: res.status, sessionId: res.headers.get("mcp-session-id"), message }
}

async function callTool(name, args) {
  const res = await post({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args ?? {} } })
  assert.equal(res.status, 200, `${name} 状态码 ${res.status}`)
  assert.ok(res.message?.result, `${name} 没返回 result:${JSON.stringify(res.message)}`)
  return res.message.result
}

let failed = false
try {
  console.log("mcp selftest:")

  // 1. initialize
  const init = await post(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: { name: "cs-selftest", version: "0.0.0" } },
    },
    { withVersion: false }
  )
  assert.equal(init.status, 200)
  assert.equal(init.message.result.serverInfo.name, "contactsheet")
  assert.ok(init.message.result.capabilities.tools, "没声明 tools 能力")
  assert.equal(init.sessionId, null, "stateless 模式不应返回 mcp-session-id")
  protocolVersion = init.message.result.protocolVersion
  ok(`initialize -> ${init.message.result.serverInfo.name} / 协议 ${protocolVersion} / 无 session`)

  // 2. initialized 通知(无 id)应当 202
  const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" })
  assert.equal(notified.status, 202, "notifications/initialized 应 202")
  ok("notifications/initialized -> 202")

  // 3. tools/list
  const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  const names = listed.message.result.tools.map(t => t.name).sort()
  assert.deepEqual(names, ["canvas_annotations", "canvas_list", "canvas_screenshot", "canvas_selection"])
  const shotTool = listed.message.result.tools.find(t => t.name === "canvas_screenshot")
  assert.ok(shotTool.description.length > 20, "工具描述太短")
  assert.equal(shotTool.inputSchema.properties.id.type, "string", "canvas_screenshot 应有可选 id 入参")
  assert.ok(!(shotTool.inputSchema.required ?? []).includes("id"), "id 应是可选的")
  ok(`tools/list -> ${names.join(", ")}`)

  // 4. canvas_selection
  const selection = await callTool("canvas_selection")
  assert.equal(selection.content[0].type, "text")
  assert.equal(JSON.parse(selection.content[0].text).selector, "button.primary")
  ok("tools/call canvas_selection -> JSON")

  // 5. canvas_list
  const list = await callTool("canvas_list")
  assert.equal(JSON.parse(list.content[0].text)[0].id, "demo.artboard--默认")
  ok("tools/call canvas_list -> JSON")

  // 6. canvas_screenshot:image content + 路径文本
  const shot = await callTool("canvas_screenshot", { id: "demo.artboard--默认" })
  assert.equal(shot.content[0].type, "image")
  assert.equal(shot.content[0].mimeType, "image/png")
  assert.equal(shot.content[0].data, PNG_1X1)
  assert.equal(shot.content[1].type, "text")
  assert.ok(shot.content[1].text.includes("design/.canvas/shots/demo.artboard--默认.png"))
  ok("tools/call canvas_screenshot -> image + 路径")

  // 7. canvas_annotations 只回 open
  const annotations = await callTool("canvas_annotations")
  const openOnes = JSON.parse(annotations.content[0].text)
  assert.equal(openOnes.length, 1)
  assert.equal(openOnes[0].id, "a1")
  ok("tools/call canvas_annotations -> 只剩 open")

  // 8. 工具内部抛错 → isError,不崩 handler
  broken.registry = true
  const boom = await callTool("canvas_list")
  assert.equal(boom.isError, true)
  assert.ok(boom.content[0].text.includes("registry 炸了"))
  broken.registry = false
  const stillAlive = await callTool("canvas_list")
  assert.ok(!stillAlive.isError, "抛错后 handler 应还能用")
  ok("工具抛错 -> isError,handler 仍存活")

  // 9. GET / DELETE 不支持
  for (const method of ["GET", "DELETE"]) {
    const res = await fetch(url, { method, headers: { accept: "application/json, text/event-stream" } })
    assert.equal(res.status, 405, `${method} 应 405`)
    const body = JSON.parse(await res.text())
    assert.equal(body.error.code, -32000)
  }
  ok("GET / DELETE -> 405 JSON-RPC 错误")
} catch (err) {
  failed = true
  console.error("FAIL:", err)
} finally {
  await new Promise(resolve => server.close(resolve))
}

console.log(failed ? "mcp selftest FAILED" : `mcp selftest passed (${results.length} checks)`)
process.exit(failed ? 1 : 0)
