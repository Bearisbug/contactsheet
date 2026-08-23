// 交互层端到端:真 next dev + 真 contactsheet + 真画布,过一遍三模式/args/HMR
import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const FIXTURE = path.join(ROOT, "spike/fixture-app")
// 专用端口:5199 可能被用户正在跑的 contactsheet 占着,撞上会把断言打到别人的画布上
const CS = "http://localhost:5642"
const results = []
const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond })
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  — " + extra : ""}`)
}

async function waitHttp(url, ms = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { await fetch(url); return true } catch { await delay(500) }
  }
  return false
}

const procs = []
const run = (cmd, args, cwd) => {
  const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
  p.stdout.on("data", () => {})
  p.stderr.on("data", () => {})
  procs.push(p)
  return p
}

const bFile = path.join(FIXTURE, "design/Button.artboard.tsx")
const bOrig = fs.readFileSync(bFile, "utf8")
let browser = null

try {
  run("pnpm", ["dev"], FIXTURE)
  await waitHttp("http://localhost:3000/")
  run("node", [path.join(ROOT, "dist/cli.js"), "--port", "5642"], FIXTURE)
  await waitHttp(`${CS}/__cs/api/state`)

  const { chromium } = await import("playwright-core")
  browser = await chromium.launch({ channel: "msedge", headless: true })
  const page = await browser.newPage({ viewport: { width: 2400, height: 1300 } })
  await page.goto(`${CS}/__cs`, { waitUntil: "networkidle" })
  await delay(4000) // 画板挂载 + 测高

  // 用 registry 定位 Button 文件的「默认」画板(多个文件都有「默认」export,按 id 找才稳)
  const reg = await (await fetch(`${CS}/__cs/registry`)).json()
  const btnEntry = reg.find((e) => e.exportName === "默认" && e.file.includes("Button"))
  const board = page.locator(`.cs-board[data-id="${btnEntry?.id}"]`)
  ok("找到 Button「默认」画板", (await board.count()) === 1, btnEntry?.id)

  // 1. 浏览模式 hover:HUD 反查
  const frameBox = await board.locator(".cs-frame").boundingBox()
  // 组件本体(iframe 里的 button)的屏幕坐标:iframe rect + 元素 rect × 实际缩放
  const btnPoint = await page.evaluate((id) => {
    const b = document.querySelector(`.cs-board[data-id="${id}"]`)
    const f = b.querySelector("iframe")
    const el = f.contentDocument.querySelector("button")
    if (!el) return null
    const fr = f.getBoundingClientRect()
    const s = fr.width / f.contentWindow.innerWidth
    const r = el.getBoundingClientRect()
    return { x: fr.left + (r.left + r.width / 2) * s, y: fr.top + (r.top + r.height / 2) * s }
  }, btnEntry.id)
  await page.mouse.move(btnPoint.x, btnPoint.y)
  await delay(300)
  const probeText = await page.locator("#cs-probe").textContent()
  ok("HUD 反查到组件本体", /button/.test(probeText ?? ""), probeText?.slice(0, 60))

  // 1b. 空白处(视口大、组件小的那片 body)不高亮不选中 —— 指着空白 = 没指任何东西
  await page.mouse.move(frameBox.x + frameBox.width - 12, frameBox.y + frameBox.height - 12)
  await delay(300)
  const hoverHidden = await page.evaluate(() => {
    const box = document.querySelector(".cs-box.is-hover")
    return !box || !box.classList.contains("is-on")
  })
  ok("空白处不高亮 body", hoverHidden)

  // 1c. 组件根往往是透明的布局容器(grid/flex):它什么都没画,也不该被当成"面板"选中。
  // 拿 危险 板(多行 grid)行区右上角的空白试 —— 那一点落在透明的行容器里
  const dangerEntry = reg.find((e) => e.exportName === "危险" && e.file.includes("Button"))
  const gapPoint = await page.evaluate((id) => {
    const f = document.querySelector(`.cs-board[data-id="${id}"] iframe`)
    const d = f?.contentDocument
    const root = d?.querySelector("[data-cs-artboard] > :not(script)")
    if (!root) return null
    const fr = f.getBoundingClientRect()
    const sc = fr.width / f.contentWindow.innerWidth
    const r = root.getBoundingClientRect()
    return { x: fr.left + (r.right - 8) * sc, y: fr.top + (r.top + 8) * sc }
  }, dangerEntry?.id)
  if (gapPoint) {
    await page.mouse.move(gapPoint.x, gapPoint.y)
    await delay(300)
    const gapHidden = await page.evaluate(() => {
      const box = document.querySelector(".cs-box.is-hover")
      return !box || !box.classList.contains("is-on")
    })
    ok("透明布局容器不被选中", gapHidden)
  } else {
    ok("透明布局容器不被选中", false, "危险板未挂载,取不到坐标")
  }

  // 1d. 组件画板 iframe 的根滚动条被隐藏(测高半路冒出来的白轨道是纯噪音)
  const sbw = await page.evaluate((id) => {
    const f = document.querySelector(`.cs-board[data-id="${id}"] iframe`)
    return f.contentWindow.getComputedStyle(f.contentDocument.documentElement).scrollbarWidth
  }, btnEntry.id)
  ok("画板根滚动条已隐藏", sbw === "none", `scrollbar-width=${sbw}`)

  // 2. 点击组件本体 → selection 落到服务端,selector 不该是 body
  await page.mouse.click(btnPoint.x, btnPoint.y)
  await delay(400)
  const sel = await (await fetch(`${CS}/__cs/api/selection`)).json()
  ok("点击生成 selection", !!sel?.selector && sel.selector !== "body", `${sel?.artboardId} > ${sel?.selector}`)

  // 3. args 面板:点标题条 → 拨 disabled → iframe URL 变 + 真禁用
  await board.locator(".cs-board-title").click()
  await delay(300)
  const panel = page.locator("#cs-args")
  ok("args 面板打开", await panel.isVisible())
  const chk = panel.locator('input[type="checkbox"]').first()
  await chk.check()
  await delay(1200) // 防抖 300ms + server 重渲
  const iframeState = await page.evaluate((id) => {
    const b = document.querySelector(`.cs-board[data-id="${id}"]`)
    const f = b.querySelector("iframe")
    return {
      url: f.contentWindow.location.href,
      disabled: !!f.contentDocument.querySelector("button[disabled]"),
      innerWidth: f.contentWindow.innerWidth,
    }
  }, btnEntry.id)
  ok("args 面板改动进 URL", iframeState.url.includes("args="), iframeState.url.slice(-60))
  ok("按钮真被禁用", iframeState.disabled)
  // 回归(verifier P3-1):声明 width:390 的画板,iframe 视口必须正好 390(border 不许偷 2px)
  ok("env.width 分毫不差", iframeState.innerWidth === 390, `innerWidth=${iframeState.innerWidth}`)
  await chk.uncheck()
  await delay(1200)

  // 4. 交互模式:双击 → overlay 放行 → **真实坐标**点击(不用 btn.click(),它绕过命中测试)
  //    先在按钮正中钉一条批注 —— 回归 verifier P1-3:pin 不许挡住交互模式的点击
  const annRes = await fetch(`${CS}/__cs/api/annotations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ artboardId: btnEntry.id, anchor: { selector: "button", x: 0.5, y: 0.5 }, text: "e2e-interact 临时批注", refs: [], status: "open" }),
  })
  const tmpAnn = await annRes.json()
  await delay(600) // SSE 推 pin
  await board.locator(".cs-frame").dblclick()
  await delay(300)
  ok("进入交互模式", (await page.evaluate(() => document.body.dataset.mode)) === "interact")
  // 算按钮正中的屏幕坐标,真实鼠标点下去
  const btnPos = await page.evaluate((id) => {
    const b = document.querySelector(`.cs-board[data-id="${id}"]`)
    const f = b.querySelector("iframe")
    const fr = f.getBoundingClientRect()
    const br = f.contentDocument.querySelector("button").getBoundingClientRect()
    const scale = fr.width / f.contentWindow.innerWidth // 世界缩放系数
    return { x: fr.x + (br.x + br.width / 2) * scale, y: fr.y + (br.y + br.height / 2) * scale }
  }, btnEntry.id)
  const hitBefore = await page.evaluate((id) => {
    const b = document.querySelector(`.cs-board[data-id="${id}"]`)
    let n = 0
    b.querySelector("iframe").contentDocument.querySelector("button")
      .addEventListener("click", () => n++, { once: true })
    window.__cs_hit = () => n
    return true
  }, btnEntry.id)
  void hitBefore
  await page.mouse.click(btnPos.x, btnPos.y)
  await delay(300)
  const hits = await page.evaluate(() => window.__cs_hit())
  ok("真实鼠标点击穿透到按钮(pin 在场)", hits === 1, `命中 ${hits} 次`)

  // 8b. 交互模式点非激活画板 → 有提示(零反馈会让人以为交互模式坏了)
  const dBox = await page.locator(`.cs-board[data-id="${dangerEntry?.id}"] .cs-frame`).boundingBox()
  if (dBox) {
    await page.mouse.click(dBox.x + dBox.width / 2, dBox.y + dBox.height / 2)
    await delay(400)
    const hint = await page.evaluate(() => [...document.querySelectorAll(".cs-toast")].map((t) => t.textContent).join("|"))
    ok("点非激活板有提示", /未激活/.test(hint), hint.slice(0, 40))
  } else {
    ok("点非激活板有提示", false, "危险板不在视口")
  }
  await fetch(`${CS}/__cs/api/annotations/${tmpAnn.id}`, { method: "DELETE" })
  await page.keyboard.press("Escape")
  await delay(200)
  ok("Esc 回浏览模式", (await page.evaluate(() => document.body.dataset.mode)) === "browse")

  // 5. HMR 链:改 artboard 文案 → iframe 热更新且不整页刷
  await page.evaluate((id) => {
    const b = document.querySelector(`.cs-board[data-id="${id}"]`)
    b.querySelector("iframe").contentWindow.__cs_marker = "alive"
  }, btnEntry.id)
  const t0 = Date.now()
  fs.writeFileSync(bFile, bOrig.replace(">保存比赛<", ">保存比赛HMR<"))
  let hmrMs = -1
  try {
    await page.waitForFunction((id) => {
      const b = document.querySelector(`.cs-board[data-id="${id}"]`)
      return b?.querySelector("iframe")?.contentDocument?.body?.textContent.includes("保存比赛HMR")
    }, btnEntry.id, { timeout: 20000 })
    hmrMs = Date.now() - t0
  } catch {}
  const marker = await page.evaluate((id) => {
    const b = document.querySelector(`.cs-board[data-id="${id}"]`)
    return b.querySelector("iframe").contentWindow.__cs_marker
  }, btnEntry.id)
  ok("HMR 穿到画板", hmrMs > 0, `${hmrMs}ms`)
  ok("HMR 不整页刷(标记存活)", marker === "alive")
  fs.writeFileSync(bFile, bOrig)

  // 5b. 回归(verifier P2-1):画板文件语法错误 → 编译错误卡(不是"dev server 未启动") → 修好自愈
  fs.writeFileSync(bFile, bOrig + "\nexport const 坏 = { render: (a) => <未闭合\n")
  let sawCompileCard = false
  try {
    await page.waitForFunction(() => {
      const boot = document.getElementById("cs-boot")
      return boot && !boot.hidden && boot.textContent.includes("画板文件编译错误")
    }, { timeout: 25000 })
    sawCompileCard = true
  } catch {}
  ok("语法错 → 编译错误卡(指对方向)", sawCompileCard)
  fs.writeFileSync(bFile, bOrig)
  let healed = false
  try {
    await page.waitForFunction((id) => {
      const boot = document.getElementById("cs-boot")
      const b = document.querySelector(`.cs-board[data-id="${id}"]`)
      return boot?.hidden && !!b
    }, btnEntry.id, { timeout: 30000 })
    healed = true
  } catch {}
  ok("修好后墙自动复活(不用刷新)", healed)

  // 6. 走查模式:Enter 铺满
  await page.mouse.click(frameBox.x + frameBox.width / 2, frameBox.y + 40)
  await page.keyboard.press("Enter")
  await delay(400)
  ok("Enter 进走查", (await page.evaluate(() => document.body.dataset.mode)) === "review")
  await page.screenshot({ path: "/tmp/cs-e2e-review.png" })
  await page.keyboard.press("Escape")
  await delay(300)

  // 7. 缩放:Ctrl+wheel
  const z0 = await page.evaluate(() => document.getElementById("cs-zoom").textContent)
  await page.mouse.move(1200, 650)
  await page.keyboard.down("Control")
  await page.mouse.wheel(0, -400)
  await page.keyboard.up("Control")
  await delay(300)
  const z1 = await page.evaluate(() => document.getElementById("cs-zoom").textContent)
  ok("Ctrl+wheel 缩放", z0 !== z1, `${z0} → ${z1}`)

  // 12. 浏览模式下对着画板按 Backspace = 收起(侧栏可点回来)
  await page.keyboard.press("Escape") // 确保回浏览模式
  await delay(300)
  await page.mouse.move(btnPoint.x, btnPoint.y) // hover 设 activeId
  await delay(300)
  await page.keyboard.press("Backspace")
  await delay(400)
  const hiddenNow = await page.evaluate((id) => document.querySelector(`.cs-board[data-id="${id}"]`)?.hidden === true, btnEntry.id)
  ok("Backspace 收起画板", hiddenNow)

  await page.screenshot({ path: "/tmp/cs-e2e-interact.png" })
} finally {
  if (browser) await browser.close().catch(() => {})
  fs.writeFileSync(bFile, bOrig)
  for (const p of procs) p.kill("SIGTERM")
  await delay(1000)
  for (const p of procs) p.kill("SIGKILL")
}

const fails = results.filter((r) => !r.pass)
console.log(`\n===== ${results.length - fails.length}/${results.length} 通过 =====`)
process.exit(fails.length ? 1 : 0)
