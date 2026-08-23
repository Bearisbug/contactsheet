// 集成视觉核验:起 fixture + contactsheet,截几张关键状态图,跑完自己收
// 用法:node scripts/shot.mjs
import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const FIXTURE = path.join(ROOT, "spike/fixture-app")
const CS = "http://localhost:5199"

const procs = []
function run(cmd, args, cwd) {
  const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env })
  p.stdout.on("data", () => {})
  p.stderr.on("data", () => {})
  procs.push(p)
  return p
}
async function waitHttp(url, ms = 90000) {
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

let browser
try {
  run("pnpm", ["dev"], FIXTURE)
  if (!(await waitHttp("http://localhost:3000/"))) throw new Error("next dev 起不来")
  run("node", [path.join(ROOT, "dist/cli.js")], FIXTURE)
  if (!(await waitHttp(`${CS}/__cs/api/state`))) throw new Error("contactsheet 起不来")

  browser = await chromium.launch({ channel: "msedge", headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  await page.goto(`${CS}/__cs`, { waitUntil: "networkidle" })
  await page.waitForSelector(".cs-board", { timeout: 30000 })
  await delay(9000) // 等首屏收尾重排 + iframe 挂载稳定

  await page.keyboard.press("1") // 全景
  await delay(1200)
  await page.screenshot({ path: "/tmp/cs-shot-1-all.png" })

  // 组件区特写:找最后一块组件画板,按 2 聚焦它所在区域
  const comp = page.locator('.cs-board[data-kind="component"]')
  const n = await comp.count()
  const box = await comp.nth(0).boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await delay(300)
    await page.keyboard.press("2")
    await delay(1200)
    await page.screenshot({ path: "/tmp/cs-shot-2-component.png" })
  }

  // 每块组件板的 iframe 实际底色:blend 档应当全等于画布 --cs-bg
  const bgs = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('.cs-board[data-kind="component"]')) {
      const f = el.querySelector("iframe")
      let inner = "(未挂载)"
      try {
        const d = f?.contentDocument
        if (d?.body) inner = getComputedStyle(d.body).backgroundColor
      } catch {
        inner = "(跨源)"
      }
      out.push({
        name: el.querySelector(".cs-board-title")?.textContent?.trim().slice(0, 24) ?? "?",
        frame: getComputedStyle(el.querySelector(".cs-frame")).backgroundColor,
        inner,
      })
    }
    return { canvasBg: getComputedStyle(document.body).backgroundColor, boards: out }
  })
  console.log("画布底色:", bgs.canvasBg)
  for (const b of bgs.boards) console.log(`  ${b.name.padEnd(26)} frame=${b.frame}  iframe=${b.inner}`)
  console.log(`组件画板 ${n} 块`)

  // 侧栏收起
  await page.keyboard.press("1")
  await delay(1000)
  await page.click("#cs-sb-toggle")
  await delay(600)
  await page.screenshot({ path: "/tmp/cs-shot-3-sidebar-off.png" })

  console.log("截图: /tmp/cs-shot-{1-all,2-component,3-sidebar-off}.png")
} finally {
  if (browser) await browser.close()
  for (const p of procs) {
    try {
      process.kill(-p.pid, "SIGTERM")
    } catch {
      p.kill("SIGTERM")
    }
  }
  await delay(1500)
  for (const p of procs) p.kill("SIGKILL")
}
