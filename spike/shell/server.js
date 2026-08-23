// spike 外壳：:5199
//   /__loupe/*  → 外壳自己（画布页）
//   其余全部    → 反代 :3000（含 WebSocket 升级，Turbopack HMR 走这条）
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import httpProxy from "http-proxy"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TARGET = "http://localhost:3000"
const PORT = 5199

const proxy = httpProxy.createProxyServer({
  target: TARGET,
  ws: true,
  // 关键实验变量：把 Host/Origin 改写成目标自己的，绕 allowedDevOrigins。
  // 想测"不改写会怎样"就把它设为 false 再跑一遍。
  changeOrigin: process.env.NO_REWRITE ? false : true,
})

proxy.on("error", (err, req, res) => {
  console.error("[proxy error]", req?.url, err.code || err.message)
  if (res && !res.headersSent && res.writeHead) {
    res.writeHead(502, { "content-type": "text/plain" })
    res.end("proxy error: " + (err.code || err.message))
  }
})

const server = http.createServer((req, res) => {
  // /__loupe/ab/* 是宿主 Next app 里的画板路由,放行给代理
  if (req.url.startsWith("/__loupe") && !req.url.startsWith("/__loupe/ab/")) {
    const file = req.url.startsWith("/__loupe/wall10") ? "wall10.html" : "canvas.html"
    const html = fs.readFileSync(path.join(__dirname, file))
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(html)
    return
  }
  proxy.web(req, res)
})

server.on("upgrade", (req, socket, head) => {
  console.log("[ws upgrade]", req.url)
  proxy.ws(req, socket, head)
})

server.listen(PORT, () => console.log(`shell on http://localhost:${PORT}  →  ${TARGET}`))
