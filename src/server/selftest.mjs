// Agent A 自测:build → 以临时目录为 projectRoot 起 CLI → 打全部外壳接口 → 清理
// 直接 node 跑:node src/server/selftest.mjs
// 注意:本机 curl 会被 Clash 劫持,这里一律用 node 内建 fetch(不走系统代理)
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

let pass = 0
const fails = []
function check(name, ok, detail = "") {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fails.push(`${name}${detail ? ` —— ${detail}` : ""}`)
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ""}`)
  }
}

/** 原样发一条请求路径(fetch 会把 .. 规范化掉,测穿越必须用裸 http) */
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (c) => (body += c))
      res.on("end", () => resolve({ status: res.statusCode, body }))
    })
    req.on("error", reject)
    req.end()
  })
}

/** 发一条 WebSocket upgrade 请求,只为踩到 server.on("upgrade") → proxy.ws 那条路 */
function wsUpgrade(port, rawPath) {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: rawPath,
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    })
    req.on("upgrade", (_res, socket) => {
      socket.destroy()
      resolve()
    })
    req.on("response", (res) => {
      res.resume()
      resolve()
    })
    req.on("error", () => resolve())
    req.on("close", () => resolve())
    req.end()
  })
}

function countOf(text, re) {
  return (text.match(re) ?? []).length
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

/** 打开 SSE 流,收到的事件按类型排队 */
async function openSse(base) {
  const ac = new AbortController()
  const res = await fetch(`${base}/__cs/events`, { signal: ac.signal, headers: { accept: "text/event-stream" } })
  const events = []
  const waiters = []
  const emit = (ev) => {
    events.push(ev)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === ev.type) {
        clearTimeout(waiters[i].timer)
        waiters[i].resolve(ev)
        waiters.splice(i, 1)
      }
    }
  }
  ;(async () => {
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const type = /^event: (.+)$/m.exec(frame)
          const data = /^data: (.*)$/m.exec(frame)
          if (type) emit({ type: type[1], data: data ? JSON.parse(data[1]) : null })
        }
      }
    } catch {
      // abort 时正常抛,忽略
    }
  })()

  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    waitFor(type, ms = 4000) {
      const hit = events.find((e) => e.type === type)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等 SSE ${type} 事件超时`)), ms)
        waiters.push({ type, resolve, timer })
      })
    },
    close: () => ac.abort(),
  }
}

async function waitReady(base, ms = 20000) {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      const r = await fetch(`${base}/__cs/api/state`)
      if (r.ok) return
    } catch {
      // 还没起来
    }
    if (Date.now() > deadline) throw new Error("外壳启动超时")
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function main() {
  console.log("· 构建 dist/")
  const built = spawnSync("node", ["build.mjs"], { cwd: repoRoot, stdio: "inherit" })
  if (built.status !== 0) throw new Error("node build.mjs 失败")

  const port = await freePort()
  const deadPort = await freePort() // 拿到就不用,保证 target 是空的
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cs-selftest-"))
  const projectRoot = fs.realpathSync(tmp)
  const base = `http://127.0.0.1:${port}`
  const target = `http://127.0.0.1:${deadPort}`

  console.log(`· 临时 projectRoot ${projectRoot}`)
  console.log(`· 外壳 ${base}  →  target ${target}(故意不存在)`)

  const child = spawn("node", [path.join(repoRoot, "dist/cli.js"), "--port", String(port), "--target", target], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let childLog = ""
  child.stdout.on("data", (d) => (childLog += d))
  child.stderr.on("data", (d) => (childLog += d))

  let sse
  try {
    await waitReady(base)

    // ---- 画布外壳 ----
    console.log("\n[画布外壳]")
    const home = await fetch(`${base}/__cs`)
    const homeHtml = await home.text()
    check("GET /__cs 返回 html", home.status === 200 && /text\/html/.test(home.headers.get("content-type") ?? ""), `status=${home.status}`)
    check(
      "画布 index.html 内容正确",
      homeHtml.includes("/__cs/ui/app.js") && homeHtml.includes("/__cs/ui/style.css") && homeHtml.includes("<title>contactsheet</title>"),
      homeHtml.slice(0, 80)
    )

    const asset = await fetch(`${base}/__cs/ui/app.js`)
    check("GET /__cs/ui/app.js 命中静态资产", asset.status === 200 && /javascript/.test(asset.headers.get("content-type") ?? ""), `status=${asset.status}`)
    const css = await fetch(`${base}/__cs/ui/style.css`)
    check("GET /__cs/ui/style.css 命中静态资产", css.status === 200)

    // 穿越:字面量 .. 被 WHATWG URL 规范化掉(落到代理),..%2f 被资产守卫挡下;两条都不能吐出包内文件
    const trav1 = await rawGet(port, "/__cs/ui/../../package.json")
    check("字面量 .. 穿越拿不到包内文件", trav1.status !== 200 && !trav1.body.includes('"dependencies"'), `status=${trav1.status}`)
    const trav2 = await rawGet(port, "/__cs/ui/..%2f..%2fpackage.json")
    check("编码 .. 穿越被资产守卫挡下", trav2.status === 400, `status=${trav2.status}`)

    // ---- state ----
    console.log("\n[/__cs/api/state]")
    const state = await (await fetch(`${base}/__cs/api/state`)).json()
    check("state.projectRoot = 临时目录", state.projectRoot === projectRoot, `${state.projectRoot}`)
    check("state.target / designDir 正确", state.target === target && state.designDir === "design", JSON.stringify(state))
    check("state.version 有值", typeof state.version === "string" && state.version.length > 0)

    // ---- selection ----
    console.log("\n[/__cs/api/selection]")
    check("初始 selection 为 null", (await (await fetch(`${base}/__cs/api/selection`)).json()) === null)
    const sel = { artboardId: "Button--默认", selector: "button.primary > span", x: 0.51, y: 0.42, ts: Date.now() }
    const selPost = await fetch(`${base}/__cs/api/selection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sel),
    })
    check("POST selection → 204", selPost.status === 204, `status=${selPost.status}`)
    const selBack = await (await fetch(`${base}/__cs/api/selection`)).json()
    check("selection 往返一致", JSON.stringify(selBack) === JSON.stringify(sel), JSON.stringify(selBack))

    // ---- annotations 全链路 + SSE ----
    console.log("\n[/__cs/api/annotations + SSE]")
    check("初始 annotations 为空表", JSON.stringify(await (await fetch(`${base}/__cs/api/annotations`)).json()) === "[]")

    sse = await openSse(base)
    check("GET /__cs/events 是 event-stream", sse.status === 200 && sse.contentType.includes("text/event-stream"), `${sse.status} ${sse.contentType}`)

    const created = await fetch(`${base}/__cs/api/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artboardId: "Button--默认", anchor: { selector: "button.primary", x: 0.5, y: 0.5 }, text: "圆角太大了" }),
    })
    const ann = await created.json()
    check("POST annotations → 201 + 完整对象", created.status === 201 && /^a[0-9a-z]+$/.test(ann.id) && ann.status === "open" && !!ann.createdAt, JSON.stringify(ann))

    const ev = await sse.waitFor("annotations")
    check("SSE 收到 annotations 事件", ev.data?.type === "annotations" && ev.data.annotations?.[0]?.id === ann.id, JSON.stringify(ev.data)?.slice(0, 120))

    const listed = await (await fetch(`${base}/__cs/api/annotations`)).json()
    check("GET annotations 拿到 1 条", listed.length === 1 && listed[0].text === "圆角太大了")

    const onDisk = path.join(projectRoot, "design/.canvas/annotations.json")
    check("annotations 落盘到 design/.canvas/", fs.existsSync(onDisk) && JSON.parse(fs.readFileSync(onDisk, "utf8")).length === 1)

    // ---- context(此时 selection + open 批注都在) ----
    console.log("\n[/__cs/api/context]")
    const ctxRes = await fetch(`${base}/__cs/api/context`)
    const ctx = await ctxRes.text()
    check("context 是 text/plain", /text\/plain/.test(ctxRes.headers.get("content-type") ?? ""))
    check("context 含当前 selection", ctx.includes("Button--默认") && ctx.includes("button.primary > span"), ctx.slice(0, 80))
    check("context 含 open 批注文本", ctx.includes("圆角太大了") && ctx.includes(ann.id))

    // ---- PATCH / DELETE ----
    console.log("\n[annotations PATCH / DELETE]")
    const patched = await fetch(`${base}/__cs/api/annotations/${ann.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved", id: "试图篡改", createdAt: "试图篡改" }),
    })
    const patchedAnn = await patched.json()
    check("PATCH → 200 且 status=resolved", patched.status === 200 && patchedAnn.status === "resolved", `status=${patched.status}`)
    check("PATCH 不许改 id / createdAt", patchedAnn.id === ann.id && patchedAnn.createdAt === ann.createdAt)

    const ctx2 = await (await fetch(`${base}/__cs/api/context`)).text()
    check("resolved 批注不再进 context", !ctx2.includes("圆角太大了") && ctx2.includes("Button--默认"))

    check("PATCH 不存在的 id → 404", (await fetch(`${base}/__cs/api/annotations/nope`, { method: "PATCH", body: "{}" })).status === 404)

    const del = await fetch(`${base}/__cs/api/annotations/${ann.id}`, { method: "DELETE" })
    check("DELETE → 204", del.status === 204, `status=${del.status}`)
    check("删完 annotations 为空表", JSON.stringify(await (await fetch(`${base}/__cs/api/annotations`)).json()) === "[]")

    // ---- context 全空 ----
    await fetch(`${base}/__cs/api/selection`, { method: "POST", headers: { "content-type": "application/json" }, body: "null" })
    const empty = await fetch(`${base}/__cs/api/context`)
    check("全空时 context 返回空 body", empty.status === 200 && (await empty.text()) === "")

    // ---- refs ----
    console.log("\n[/__cs/api/refs]")
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64")
    const refRes = await fetch(`${base}/__cs/api/refs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "../../evil linear.png", dataBase64: `data:image/png;base64,${png}` }),
    })
    const ref = await refRes.json()
    const day = new Date().toISOString().slice(0, 10)
    check("POST refs → {path}", refRes.status === 200 && ref.path === `design/.canvas/refs/${day}-evil-linear.png`, JSON.stringify(ref))
    check("refs 文件真的落盘", fs.existsSync(path.join(projectRoot, ref.path)))
    check("refs 没被穿越到 projectRoot 外", ref.path.startsWith("design/.canvas/refs/"))

    // ---- 下游模块接线 ----
    console.log("\n[下游模块接线]")
    // 用一个不存在的 id:shot 模块会先取注册表,target 没起必然失败 —— 正好验 500 分支,且不会拉起浏览器
    const shot = await fetch(`${base}/__cs/api/screenshot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "__no_such_artboard__" }),
    })
    const shotText = await shot.text()
    check("screenshot 出错 → 500 + 错误文本", shot.status === 500 && shotText.includes("screenshot 失败"), `status=${shot.status} ${shotText.slice(0, 60)}`)
    // MCP:D 未就绪时降级 501,已就绪时由 SDK 自己回话(缺 Accept 头会给 406);都不该是 404
    const mcp = await fetch(`${base}/__cs/mcp`, { method: "POST", body: "{}" })
    check(`/__cs/mcp 已挂载(status=${mcp.status},501=D 未就绪的降级)`, mcp.status !== 404)

    // ---- 代理 ----
    console.log("\n[代理到未启动的 target]")
    const root = await fetch(`${base}/`)
    const rootHtml = await root.text()
    check("GET / → 502", root.status === 502, `status=${root.status}`)
    check("502 简页提示目标未启动", rootHtml.includes("未启动") && rootHtml.includes(target), rootHtml.slice(0, 80))
    const ab = await fetch(`${base}/__cs/ab/Button--%E9%BB%98%E8%AE%A4`)
    check("/__cs/ab/* 走代理(非外壳 404)", ab.status === 502, `status=${ab.status}`)
    const reg = await fetch(`${base}/__cs/registry`)
    check("/__cs/registry 走代理", reg.status === 502, `status=${reg.status}`)
    const unknownApi = await fetch(`${base}/__cs/api/nope`)
    check("未知外壳 API → 404(不代理)", unknownApi.status === 404, `status=${unknownApi.status}`)

    // ---- 代理错误日志:去重 + 限流 ----
    // 复刻真实事故:next dev 挂了,浏览器 HMR 客户端每秒几十次重连,每次带新的 ?id=
    console.log("\n[代理错误日志去重限流]")
    let mark = childLog.length
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => fetch(`${base}/_next/hmr?id=${Math.random().toString(36).slice(2)}${i}`).catch(() => {}))
    )
    for (let i = 0; i < 20; i++) await wsUpgrade(port, `/_next/webpack-hmr?id=ws${i}`)
    await new Promise((r) => setTimeout(r, 300))
    const flood = childLog.slice(mark)
    check("60 次 HMR 重连(http+ws)零逐条日志", countOf(flood, /代理失败/g) === 0, `多打了 ${countOf(flood, /代理失败/g)} 条`)
    check("整场只说一次「连不上了」", countOf(childLog, /连不上了/g) === 1, `出现 ${countOf(childLog, /连不上了/g)} 次`)

    // 换一个"接上就掐"的 target:错误码不是 ECONNREFUSED,走合并窗口那条路
    const rude = net.createServer((s) => s.destroy())
    await new Promise((r) => rude.listen(deadPort, "127.0.0.1", r))
    mark = childLog.length
    for (let i = 0; i < 30; i++) await fetch(`${base}/_next/hmr?id=r${i}`).catch(() => {})
    await new Promise((r) => setTimeout(r, 400))
    const first = childLog.slice(mark)
    check("同类失败窗口内只打首条", countOf(first, /代理失败/g) === 1, `打了 ${countOf(first, /代理失败/g)} 条:${first.slice(0, 200)}`)
    check("首条路径已去掉查询串", /代理失败 \/_next\/hmr /.test(first), first.slice(0, 120))
    await new Promise((r) => setTimeout(r, 5200)) // 等窗口结束的补充行
    const tail = childLog.slice(mark)
    check("窗口结束补一句「还有 N 次」", /过去 5 秒还有 29 次同类失败/.test(tail), tail.slice(-200))
    await new Promise((r) => rude.close(r))

    // 真 target 起来 → 一条「已恢复」
    const real = http.createServer((_, res) => res.end("ok"))
    await new Promise((r) => real.listen(deadPort, "127.0.0.1", r))
    mark = childLog.length
    const back = await fetch(`${base}/`)
    await new Promise((r) => setTimeout(r, 300))
    check("目标起来后代理正常", back.status === 200 && (await back.text()) === "ok", `status=${back.status}`)
    check("恢复时打一行「已恢复」", countOf(childLog.slice(mark), /已恢复/g) === 1, childLog.slice(mark).slice(0, 200))
    await new Promise((r) => real.close(r))
  } finally {
    if (sse) sse.close()
    // 优雅退出:SIGTERM → 等 exit
    const exited = new Promise((resolve) => child.once("exit", (code, sig) => resolve({ code, sig })))
    child.kill("SIGTERM")
    const killer = setTimeout(() => child.kill("SIGKILL"), 5000)
    const how = await exited
    clearTimeout(killer)
    check("SIGTERM 后进程优雅退出(code 0)", how.code === 0, `code=${how.code} sig=${how.sig}`)
    check("退出日志走优雅退出分支", childLog.includes("收到 SIGTERM"))
    fs.rmSync(tmp, { recursive: true, force: true })
    check("临时目录已清理", !fs.existsSync(tmp))
    if (fails.length) console.log(`\n--- 子进程日志 ---\n${childLog}`)
  }

  console.log(`\n通过 ${pass} 项,失败 ${fails.length} 项`)
  if (fails.length) {
    for (const f of fails) console.log(`  ✗ ${f}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("\n自测异常:", err)
  process.exit(1)
})
