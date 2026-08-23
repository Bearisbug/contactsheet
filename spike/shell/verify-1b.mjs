// spike 1B:宿主 next dev 路线
//  ① 单块画板 P1-P5 全渲染?(含 async server + server-only 桶)
//  ② 根 layout 生效?(字体应是 Geist 一族,而非 Vite 路线的 Times 兜底)
//  ③ 10 块并排:全部出画要多久,是一次路由编译还是十次
import { chromium } from "playwright-core"

const browser = await chromium.launch({ channel: "msedge", headless: true })
const results = { single: {}, wall10: {} }

// ① + ② 单块:p4(最难的那块)
{
  const page = await browser.newPage({ viewport: { width: 500, height: 400 } })
  const t0 = Date.now()
  await page.goto("http://localhost:5199/__loupe/ab/p4-server-async", { waitUntil: "networkidle" })
  await page.waitForSelector('[data-probe="p4"]', { timeout: 20000 })
  results.single.p4Ms = Date.now() - t0
  results.single.p4Text = await page.evaluate(
    () => document.querySelector('[data-probe="p4"]').textContent.slice(0, 60)
  )
  await page.goto("http://localhost:5199/__loupe/ab/p1-default", { waitUntil: "networkidle" })
  await page.waitForSelector('[data-probe="p1-button"]', { timeout: 20000 })
  results.single.p1Font = await page.evaluate(() =>
    getComputedStyle(document.querySelector('[data-probe="p1-button"]')).fontFamily.slice(0, 70)
  )
  await page.close()
}

// ③ 10 块墙
{
  const page = await browser.newPage({ viewport: { width: 2100, height: 700 } })
  const consoleErrors = []
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 120)))
  const t0 = Date.now()
  await page.goto("http://localhost:5199/__loupe/wall10", { waitUntil: "domcontentloaded" })
  // 等 10 个 iframe 各自出现画板内容或错误
  await page.waitForFunction(
    () => {
      const frames = [...document.querySelectorAll("iframe")]
      return (
        frames.length === 10 &&
        frames.every((f) => {
          try {
            return f.contentDocument?.querySelector("[data-artboard],[data-probe]")
          } catch {
            return false
          }
        })
      )
    },
    { timeout: 60000 }
  )
  results.wall10.allPaintedMs = Date.now() - t0
  results.wall10.boards = await page.evaluate(() =>
    [...document.querySelectorAll("iframe")].map((f) => {
      const d = f.contentDocument
      const ab = d.querySelector("[data-artboard]")
      return {
        id: ab?.dataset.artboard ?? "(无)",
        probes: [...d.querySelectorAll("[data-probe]")].map((e) => e.dataset.probe).join(","),
      }
    })
  )
  results.wall10.consoleErrors = consoleErrors.slice(0, 5)
  await page.screenshot({ path: "/tmp/cs-spike1b-wall10.png" })
  await page.close()
}

console.log(JSON.stringify(results, null, 2))
await browser.close()
