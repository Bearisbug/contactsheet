// 画布自测:起一个假外壳(node:http)喂假 registry / 假画板页 / 内存 API,
// 用 Edge headless 打开 /__cs 跑一遍关键交互。
// 跑法:node build.mjs && node src/canvas/selftest.mjs
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { chromium } from "playwright-core"

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, "..", "..", "dist", "canvas")
const SHOT = "/tmp/cs-canvas-selftest.png"

// ---------------- 假数据 ----------------

const ID_A = "Button.artboard--默认"
const ID_B = "Button.artboard--危险"
const ID_C = "screens.artboard--仪表盘"
const ID_D = "Button.artboard--加载中"

const registry = [
  {
    id: ID_A,
    file: "design/Button.artboard.tsx",
    exportName: "默认",
    kind: "component",
    args: { variant: "default", disabled: false, count: 3, meta: { tone: "quiet" } },
    env: { width: 360 },
  },
  {
    id: ID_B,
    file: "design/Button.artboard.tsx",
    exportName: "危险",
    kind: "component",
    args: { variant: "danger", disabled: true },
    env: { width: 360 },
  },
  {
    id: ID_C,
    file: "design/screens.artboard.ts",
    exportName: "仪表盘",
    kind: "screen",
    url: "/screens/dashboard",
    env: { width: 420 },
  },
]

const store = { selection: null, annotations: [], refs: [] }
/** 置真后 /__cs/registry 返回 502,用来验"目标 dev server 未启动"提示卡 */
const broken = { on: false }
const hits = { ab: [], selection: [], annotations: [], patches: [], refs: [] }
const sse = new Set()

function pushEvent(payload) {
  const chunk = `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const res of sse) res.write(chunk)
}

/** 假画板页:带 #__cs_meta + 几个可选中的元素,内容高固定 520(便于断言自动测高) */
function artboardHtml(entry, args, boxHeight) {
  const meta = JSON.stringify({ id: entry.id, args, env: entry.env ?? {}, kind: entry.kind })
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
    body { margin: 8px; font: 14px/1.6 system-ui, sans-serif; color: #1c1f24; }
    .card { box-sizing: border-box; height: ${boxHeight}px; padding: 18px;
            border: 1px solid #e3e6ea; border-radius: 10px; background: #fbfcfd; }
    h3 { margin: 0 0 12px; font-size: 15px; }
    button { padding: 8px 16px; border: 1px solid #c9ced6; border-radius: 6px; background: #fff; }
    ul { padding-left: 18px; color: #5b6472; }
  </style></head><body>
    <div class="card" data-artboard="${entry.id}">
      <h3>${entry.exportName}</h3>
      <button id="save" data-probe="save-btn" class="btn primary">保存</button>
      <p class="hint">variant = ${String(args.variant ?? "-")} / disabled = ${String(args.disabled ?? "-")}</p>
      <ul><li>列表项一</li><li>列表项二</li><li>列表项三</li></ul>
    </div>
    <script type="application/json" id="__cs_meta">${meta}</script>
  </body></html>`
}

function screenHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
    body { margin: 8px; font: 14px/1.6 system-ui, sans-serif; color: #1c1f24; }
    .page { box-sizing: border-box; height: 700px; padding: 20px; border: 1px solid #e3e6ea;
            border-radius: 10px; background: linear-gradient(180deg,#ffffff,#f4f6f9); }
    .tile { height: 96px; margin-bottom: 12px; border-radius: 8px; background: #eef1f6; }
  </style></head><body>
    <div class="page" data-artboard="screen">
      <h3 data-probe="screen-title">仪表盘</h3>
      <div class="tile" id="tile-1"></div>
      <div class="tile" id="tile-2"></div>
    </div>
  </body></html>`
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : null)
      } catch {
        resolve(null)
      }
    })
  })
}

function send(res, code, type, body) {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" })
  res.end(body)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x")
  const p = decodeURIComponent(url.pathname)

  if (p === "/__cs" || p === "/__cs/") return send(res, 200, "text/html", readFileSync(join(DIST, "index.html")))
  if (p === "/__cs/ui/app.js") return send(res, 200, "text/javascript", readFileSync(join(DIST, "app.js")))
  if (p === "/__cs/ui/style.css") return send(res, 200, "text/css", readFileSync(join(DIST, "style.css")))

  if (p === "/__cs/api/state")
    return send(
      res,
      200,
      "application/json",
      JSON.stringify({
        version: "0.1.0-selftest",
        target: "http://localhost:3000",
        designDir: "design",
        projectRoot: "/tmp/fake-repo",
      })
    )

  if (p === "/__cs/registry") {
    if (broken.on) return send(res, 502, "text/plain", "contactsheet:目标 :3000 未启动")
    return send(res, 200, "application/json", JSON.stringify(registry))
  }

  if (p.startsWith("/__cs/ab/")) {
    hits.ab.push(req.url)
    const id = p.slice("/__cs/ab/".length)
    const entry = registry.find((e) => e.id === id)
    if (!entry) return send(res, 404, "text/plain", "no such artboard")
    let args = { ...(entry.args ?? {}) }
    const raw = url.searchParams.get("args")
    if (raw) {
      try {
        args = { ...args, ...JSON.parse(raw) }
      } catch {
        /* 忽略坏 args */
      }
    }
    return send(res, 200, "text/html", artboardHtml(entry, args, 520))
  }

  if (p === "/screens/dashboard") return send(res, 200, "text/html", screenHtml())

  if (p === "/__cs/api/selection") {
    if (req.method === "POST") {
      store.selection = await readBody(req)
      hits.selection.push(store.selection)
      res.writeHead(204)
      return res.end()
    }
    return send(res, 200, "application/json", JSON.stringify(store.selection))
  }

  if (p === "/__cs/api/annotations") {
    if (req.method === "POST") {
      const body = await readBody(req)
      hits.annotations.push(body)
      const ann = {
        ...body,
        id: `a${store.annotations.length + 1}`,
        refs: body.refs ?? [],
        status: body.status ?? "open",
        createdAt: new Date().toISOString(),
      }
      store.annotations.push(ann)
      send(res, 201, "application/json", JSON.stringify(ann))
      pushEvent({ type: "annotations", annotations: store.annotations })
      return
    }
    return send(res, 200, "application/json", JSON.stringify(store.annotations))
  }

  if (p.startsWith("/__cs/api/annotations/") && req.method === "PATCH") {
    const id = p.split("/").pop()
    const patch = await readBody(req)
    hits.patches.push({ id, patch })
    const ann = store.annotations.find((a) => a.id === id)
    if (!ann) return send(res, 404, "text/plain", "no")
    Object.assign(ann, patch)
    send(res, 200, "application/json", JSON.stringify(ann))
    pushEvent({ type: "annotations", annotations: store.annotations })
    return
  }

  if (p === "/__cs/api/refs" && req.method === "POST") {
    const body = await readBody(req)
    hits.refs.push({ name: body?.name, bytes: (body?.dataBase64 ?? "").length })
    const path = `design/.canvas/refs/2026-08-22-${body?.name ?? "x.png"}`
    store.refs.push(path)
    return send(res, 200, "application/json", JSON.stringify({ path }))
  }

  if (p === "/__cs/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    res.write(": hello\n\n")
    sse.add(res)
    req.on("close", () => sse.delete(res))
    return
  }

  send(res, 404, "text/plain", "not found")
})

await new Promise((r) => server.listen(0, "127.0.0.1", r))
const PORT = server.address().port
const ORIGIN = `http://127.0.0.1:${PORT}`

// ---------------- 断言工具 ----------------

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail === undefined ? "" : `  → ${JSON.stringify(detail)}`}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------- 跑 ----------------

const browser = await chromium.launch({ channel: "msedge", headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const pageErrors = []
page.on("pageerror", (e) => pageErrors.push(String(e)))

try {
  await page.goto(`${ORIGIN}/__cs`, { waitUntil: "domcontentloaded" })

  // ① 三块画板挂出(iframe 真的加载了内容)
  await page.waitForFunction(
    () => {
      const frames = [...document.querySelectorAll(".cs-board iframe")]
      return frames.length === 3 && frames.every((f) => f.contentDocument?.querySelector("[data-artboard]"))
    },
    { timeout: 15000 }
  )
  const wall = await page.evaluate(() => ({
    boards: document.querySelectorAll(".cs-board").length,
    groups: [...document.querySelectorAll(".cs-group-title")].map((t) => t.textContent),
    badges: [...document.querySelectorAll(".cs-badge")].map((b) => b.textContent),
    widths: [...document.querySelectorAll(".cs-frame")].map((f) => f.style.width),
    heights: [...document.querySelectorAll(".cs-frame")].map((f) => parseFloat(f.style.height)),
    argsN: [...document.querySelectorAll(".cs-args-n")].map((e) => e.textContent),
  }))
  check("三块画板挂出", wall.boards === 3, wall.boards)
  check("按文件分组成列 + 组标题去后缀", wall.groups.join("|") === "Button2|screens1", wall.groups)
  check("kind 徽标 = component/component/screen", wall.badges.join(",") === "component,component,screen", wall.badges)
  check("宽度取 env.width", wall.widths.join(",") === "360px,360px,420px", wall.widths)
  check("args 数显示在标题条", wall.argsN[0] === "4 args" && wall.argsN[2] === "", wall.argsN)
  // 内容高 520 + body margin 16 = 536;screen 页 700 + 16 = 716
  check(
    "自动测高(component≈536 / screen≈716)",
    Math.abs(wall.heights[0] - 536) <= 4 && Math.abs(wall.heights[2] - 716) <= 4,
    wall.heights
  )

  const layoutBefore = await page.evaluate(() =>
    [...document.querySelectorAll(".cs-board")].map((b) => ({
      id: b.dataset.id,
      top: b.style.top,
      left: b.parentElement.style.left,
    }))
  )

  // ② 缩放(以光标为锚)+ 平移改 transform
  const readView = () =>
    page.evaluate(() => {
      const m = new DOMMatrix(getComputedStyle(document.getElementById("cs-world")).transform)
      return { scale: m.a, tx: m.e, ty: m.f }
    })
  const v0 = await readView()
  const wheel = (opts) =>
    page.evaluate((o) => {
      document.getElementById("cs-viewport").dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, ...o })
      )
    }, opts)

  await wheel({ deltaY: -100, ctrlKey: true, clientX: 500, clientY: 400 })
  const v1 = await readView()
  const anchor0 = (500 - v0.tx) / v0.scale
  const anchor1 = (500 - v1.tx) / v1.scale
  check("Ctrl+wheel 放大", v1.scale > v0.scale * 1.3, { from: v0.scale, to: v1.scale })
  check("缩放以光标为锚点", Math.abs(anchor0 - anchor1) < 1, { anchor0, anchor1 })
  await wheel({ deltaY: 100, ctrlKey: true, clientX: 500, clientY: 400 })
  const vz = await readView()
  check("反向 Ctrl+wheel 还原缩放", Math.abs(vz.scale - v0.scale) < 0.01, { back: vz.scale })

  await wheel({ deltaX: 120, deltaY: 60 })
  const v2 = await readView()
  check("双指滚轮平移", Math.abs(v2.tx - (vz.tx - 120)) < 1.5 && Math.abs(v2.ty - (vz.ty - 60)) < 1.5, {
    before: vz,
    after: v2,
  })
  await wheel({ deltaX: -120, deltaY: -60 })

  // 空白处拖拽平移
  const v3 = await readView()
  await page.mouse.move(1050, 60)
  await page.mouse.down()
  await page.mouse.move(1150, 140, { steps: 4 })
  await page.mouse.up()
  const v4 = await readView()
  check("空白处拖拽平移", Math.abs(v4.tx - (v3.tx + 100)) < 1.5 && Math.abs(v4.ty - (v3.ty + 80)) < 1.5, {
    before: v3,
    after: v4,
  })
  await page.mouse.move(1150, 140)
  await page.mouse.down()
  await page.mouse.move(1050, 60, { steps: 4 })
  await page.mouse.up()

  // ③ 浏览模式 hover 高亮 + HUD 反查
  const posOf = (id, sel) =>
    page.evaluate(
      ([bid, s]) => {
        const board = document.querySelector(`.cs-board[data-id="${bid}"]`)
        const iframe = board.querySelector("iframe")
        const m = new DOMMatrix(getComputedStyle(document.getElementById("cs-world")).transform)
        const fr = iframe.getBoundingClientRect()
        const b = iframe.contentDocument.querySelector(s).getBoundingClientRect()
        return { x: fr.left + (b.left + b.width / 2) * m.a, y: fr.top + (b.top + b.height / 2) * m.a }
      },
      [id, sel]
    )

  const saveBtn = await posOf(ID_A, "#save")
  await page.mouse.move(saveBtn.x, saveBtn.y)
  await sleep(120)
  const hover = await page.evaluate(() => {
    const box = document.querySelector('.cs-box[data-kind="hover"]')
    return {
      on: box.classList.contains("is-on"),
      w: parseFloat(box.style.width),
      h: parseFloat(box.style.height),
      probe: document.getElementById("cs-probe").textContent,
    }
  })
  check("hover 出高亮框", hover.on && hover.w > 20 && hover.h > 10, hover)
  check("HUD 显示 tag/probe", hover.probe.includes("<button>") && hover.probe.includes("probe=save-btn"), hover.probe)

  // ④ 点击 → 生成 selector → POST /__cs/api/selection
  await page.mouse.click(saveBtn.x, saveBtn.y)
  await sleep(200)
  const sel = hits.selection.at(-1)
  check("click 后 selection POST 到达", !!sel, sel)
  check("selector 优先用 id", sel?.selector === "#save", sel?.selector)
  check("selection 带 artboardId 与相对坐标", sel?.artboardId === ID_A && sel.x >= 0 && sel.x <= 1, {
    id: sel?.artboardId,
    x: sel?.x,
    y: sel?.y,
  })
  check(
    "选中框显示",
    await page.evaluate(() => document.querySelector('.cs-box[data-kind="select"]').classList.contains("is-on"))
  )

  // 无 id 的元素退化到 标签+nth-of-type 链
  const li = await posOf(ID_A, "li:nth-of-type(2)")
  await page.mouse.click(li.x, li.y)
  await sleep(200)
  check("无 id 元素退化为 nth-of-type 链", hits.selection.at(-1)?.selector.includes("li:nth-of-type(2)"), hits.selection.at(-1)?.selector)

  // ⑤ 双击进交互模式:overlay pointer-events 变 none,其余画板压暗
  await page.mouse.dblclick(saveBtn.x, saveBtn.y)
  await sleep(150)
  const interact = await page.evaluate((bid) => {
    const active = document.querySelector(`.cs-board[data-id="${bid}"]`)
    const other = [...document.querySelectorAll(".cs-board")].find((b) => b !== active)
    return {
      mode: document.body.dataset.mode,
      activePe: getComputedStyle(active.querySelector(".cs-ovl")).pointerEvents,
      otherPe: getComputedStyle(other.querySelector(".cs-ovl")).pointerEvents,
      otherOpacity: getComputedStyle(other).opacity,
    }
  }, ID_A)
  check("双击进交互模式", interact.mode === "interact", interact.mode)
  check("交互板 overlay pointer-events:none", interact.activePe === "none", interact)
  check("其余画板压暗 + 仍拦事件", interact.otherOpacity === "0.4" && interact.otherPe === "auto", interact)

  // ⑥ Esc 回浏览
  await page.keyboard.press("Escape")
  await sleep(100)
  check("Esc 回浏览", (await page.evaluate(() => document.body.dataset.mode)) === "browse")

  // ⑦ Enter 走查:该板铺满,其余隐藏;Esc 还原视图
  const viewBeforeReview = await readView()
  await page.keyboard.press("Enter")
  await sleep(200)
  const review = await page.evaluate((bid) => {
    const active = document.querySelector(`.cs-board[data-id="${bid}"]`)
    const other = [...document.querySelectorAll(".cs-board")].find((b) => b !== active)
    const m = new DOMMatrix(getComputedStyle(document.getElementById("cs-world")).transform)
    const r = active.querySelector(".cs-frame").getBoundingClientRect()
    return {
      mode: document.body.dataset.mode,
      scale: m.a,
      otherVisible: getComputedStyle(other).visibility,
      fills: r.height / window.innerHeight,
      centered: Math.abs(r.left + r.width / 2 - window.innerWidth / 2) < 2,
    }
  }, ID_A)
  check("Enter 进走查模式", review.mode === "review", review.mode)
  check("走查:画板铺满并居中", review.fills > 0.95 && review.centered, review)
  check("走查:其余画板隐藏", review.otherVisible === "hidden", review.otherVisible)
  await page.keyboard.press("Escape")
  await sleep(200)
  const viewAfter = await readView()
  check(
    "Esc 退出走查并还原视图",
    (await page.evaluate(() => document.body.dataset.mode)) === "browse" &&
      Math.abs(viewAfter.scale - viewBeforeReview.scale) < 0.001,
    { before: viewBeforeReview.scale, after: viewAfter.scale }
  )

  // ⑧ args 面板:点标题条 → 改 checkbox → iframe URL 带 args=
  await page.click(`.cs-board[data-id="${ID_A}"] .cs-board-title`)
  await sleep(150)
  const panel = await page.evaluate(() => ({
    open: !document.getElementById("cs-args").hidden,
    fields: [...document.querySelectorAll("#cs-args .cs-field")].length,
    types: [...document.querySelectorAll("#cs-args input, #cs-args textarea")].map((e) => e.type || "textarea"),
    saveDisabled: document.querySelector("#cs-args .cs-args-foot button").disabled,
  }))
  check("单击标题条开 args 面板", panel.open, panel)
  check("按值类型出控件(text/checkbox/number/textarea)", panel.types.join(",") === "text,checkbox,number,textarea", panel.types)
  check("「存为画板」禁用占位", panel.saveDisabled)

  await page.click("#cs-args input[type=checkbox]")
  await sleep(600) // 去抖 300ms + 重载
  const applied = await page.evaluate(
    (bid) => {
      const iframe = document.querySelector(`.cs-board[data-id="${bid}"] iframe`)
      return { href: iframe.contentWindow.location.href, csUrl: iframe.dataset.csUrl }
    },
    ID_A
  )
  const abHit = hits.ab.at(-1)
  check("改 args 后 iframe URL 带 args=", applied.href.includes("args=") && applied.csUrl.includes("args="), applied.href.slice(-60))
  check("服务端收到带 args 的画板请求", abHit?.includes("args=") && decodeURIComponent(abHit).includes('"disabled":true'), decodeURIComponent(abHit ?? ""))

  // ⑨ pin 批注:c → 点元素 → 输入 → POST annotations → 画出 pin
  // (焦点还在 args 面板的输入控件里时快捷键按设计不生效,先移开焦点)
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press("c")
  await sleep(80)
  check("按 c 进批注状态", (await page.evaluate(() => document.body.dataset.pin)) === "on")
  const saveBtn2 = await posOf(ID_A, "#save")
  await page.mouse.click(saveBtn2.x, saveBtn2.y)
  await sleep(150)
  check("出现就地输入框", (await page.locator(".cs-pin-input textarea").count()) === 1)
  await page.keyboard.type("这里的间距偏紧")
  await page.keyboard.press("Enter")
  await sleep(400)
  const ann = hits.annotations.at(-1)
  check("批注 POST 到达(带 anchor)", ann?.text === "这里的间距偏紧" && ann?.anchor?.selector === "#save", ann)
  check("批注 pin 画出来了", (await page.locator(`.cs-board[data-id="${ID_A}"] .cs-pin`).count()) === 1)
  check("批注后退出批注状态", (await page.evaluate(() => document.body.dataset.pin)) === "off")

  // ⑩ 贴图:paste 图片 → POST refs → 右下角缩略图
  await page.evaluate(() => {
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], "linear.png", { type: "image/png" }))
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await sleep(400)
  check("paste 图片 → POST /__cs/api/refs", hits.refs.length === 1 && hits.refs[0].name === "linear.png", hits.refs[0])
  check("右下角出现缩略图", (await page.locator("#cs-refs .cs-ref").count()) === 1)
  await page.click("#cs-refs .cs-ref")
  await sleep(150)
  check("点缩略图开大图浮层", (await page.evaluate(() => !document.getElementById("cs-lightbox").hidden)))
  await page.click("#cs-lightbox")
  await sleep(100)

  // ⑪ SSE registry 事件:增量加板,已有画板位置不动,新板排组尾
  registry.push({
    id: ID_D,
    file: "design/Button.artboard.tsx",
    exportName: "加载中",
    kind: "component",
    args: { loading: true },
    env: { width: 360 },
  })
  pushEvent({ type: "registry", entries: registry })
  await page.waitForFunction(() => document.querySelectorAll(".cs-board").length === 4, { timeout: 10000 })
  await sleep(400)
  const layoutAfter = await page.evaluate(() =>
    [...document.querySelectorAll(".cs-board")].map((b) => ({
      id: b.dataset.id,
      top: b.style.top,
      left: b.parentElement.style.left,
    }))
  )
  const stable = layoutBefore.every((b) => {
    const now = layoutAfter.find((n) => n.id === b.id)
    return now && now.top === b.top && now.left === b.left
  })
  const tail = layoutAfter.find((b) => b.id === ID_D)
  const prevTop = Math.max(...layoutAfter.filter((b) => b.id !== ID_D && b.left === tail.left).map((b) => parseFloat(b.top)))
  check("SSE registry:增量加板", layoutAfter.length === 4)
  check("已有画板位置不动", stable, { before: layoutBefore, after: layoutAfter })
  check("新画板排在组尾", parseFloat(tail.top) > prevTop, { tail: tail.top, prevTop })

  // ⑫ 懒挂载:视口外 1.5 屏以上的画板只出占位,不挂 iframe
  for (const n of [1, 2, 3]) {
    registry.push({
      id: `Button.artboard--远处${n}`,
      file: "design/Button.artboard.tsx",
      exportName: `远处${n}`,
      kind: "component",
      env: { width: 360 },
    })
  }
  pushEvent({ type: "registry", entries: registry })
  await page.waitForFunction(() => document.querySelectorAll(".cs-board").length === 7, { timeout: 10000 })
  await sleep(500)
  const lazy = await page.evaluate(() =>
    [...document.querySelectorAll(".cs-board")].map((b) => ({
      id: b.dataset.id,
      screenTop: Math.round(b.getBoundingClientRect().top),
      mounted: !!b.querySelector("iframe"),
      ph: !b.querySelector(".cs-ph").hidden,
    }))
  )
  check(
    "视口外 1.5 屏的画板只出灰卡占位",
    lazy.some((b) => !b.mounted && b.ph),
    lazy
  )
  check("视口内的画板都已挂 iframe", lazy.filter((b) => b.screenTop < 900).every((b) => b.mounted), lazy)

  // ⑬ pin 气泡 + resolve → PATCH
  await page.locator(`.cs-board[data-id="${ID_A}"] .cs-pin`).hover()
  await sleep(150)
  const bubble = await page.evaluate((bid) => {
    const b = document.querySelector(`.cs-board[data-id="${bid}"] .cs-pin-bubble`)
    return { shown: getComputedStyle(b).display !== "none", text: b.textContent }
  }, ID_A)
  check("hover pin 出气泡(文本+status)", bubble.shown && bubble.text.includes("这里的间距偏紧") && bubble.text.includes("open"), bubble)
  await page.locator(`.cs-board[data-id="${ID_A}"] .cs-pin-meta button`).click()
  await sleep(300)
  check("气泡里 resolve → PATCH 到达", hits.patches.at(-1)?.patch?.status === "resolved", hits.patches.at(-1))
  check(
    "pin 重画为 resolved",
    (await page.locator(`.cs-board[data-id="${ID_A}"] .cs-pin.is-resolved`).count()) === 1
  )

  // ⑭ SSE annotations:锚点找不到的批注退化成孤儿 pin(画板左上角)
  store.annotations.push({
    id: "a2",
    artboardId: ID_A,
    anchor: { selector: "#这个元素不存在", x: 0.5, y: 0.5 },
    text: "锚点丢了的批注",
    refs: [],
    status: "open",
    createdAt: new Date().toISOString(),
  })
  pushEvent({ type: "annotations", annotations: store.annotations })
  await sleep(300)
  check("锚点找不到 → 孤儿 pin 落画板左上角", (await page.locator(`.cs-board[data-id="${ID_A}"] .cs-pin.is-orphan`).count()) === 1)

  check("控制台无未捕获错误", pageErrors.length === 0, pageErrors.slice(0, 3))

  // 出图前把视图归到一个好看的位置
  await page.click(`.cs-board[data-id="${ID_C}"] .cs-board-title`)
  await sleep(200)
  await page.mouse.move(20, 20)
  await sleep(150)
  await page.screenshot({ path: SHOT })
  console.log(`\n截图:${SHOT}`)

  // ⑭ registry 拉不到 → 中央提示卡
  broken.on = true
  const page2 = await browser.newPage({ viewport: { width: 900, height: 600 } })
  await page2.goto(`${ORIGIN}/__cs`, { waitUntil: "domcontentloaded" })
  await page2.waitForSelector("#cs-boot .cs-card", { timeout: 8000 }).catch(() => {})
  const boot = await page2.evaluate(() => {
    const el = document.querySelector("#cs-boot")
    return { visible: el && !el.hidden, text: el?.textContent ?? "" }
  })
  check("dev server 没起 → 中央提示卡", boot.visible && boot.text.includes("未启动"), boot.text.slice(0, 40))
  await page2.close()
} finally {
  await browser.close()
  for (const res of sse) res.end()
  server.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log("失败项:", failed.map((f) => f.name).join(" / "))
  process.exit(1)
}
