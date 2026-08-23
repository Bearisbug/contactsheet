// spike 2b:HMR 穿代理 + Link 不逃逸
//  ① 改组件文件 → iframe 热更新:文本变了、React state(点击计数)保住、window 标记还在(没整页刷)
//  ② iframe 里点 <Link href="/settings"> → 导航发生在 iframe 内、仍在 :5199 域下
import { chromium } from "playwright-core"
import fs from "node:fs"

const FILE =
  "/Users/bug/Documents/Projects/contactsheet/spike/fixture-app/components/probes/p1-pure-client.tsx"
const orig = fs.readFileSync(FILE, "utf8")

const browser = await chromium.launch({ channel: "msedge", headless: true })
const page = await browser.newPage({ viewport: { width: 2400, height: 900 } })
await page.goto("http://localhost:5199/__loupe", { waitUntil: "networkidle" })
for (const f of page.frames()) {
  if (f === page.mainFrame()) continue
  await f.waitForSelector('[data-probe="p1-button"]', { timeout: 15000 })
}

const results = { hmr: {}, link: {}, }

// 准备:在 390 那块里点一次按钮(计数→1),并在 contentWindow 上做标记
await page.evaluate(() => {
  const iframe = document.querySelector('.board[data-w="390"] iframe')
  iframe.contentWindow.__no_reload_marker = "alive"
  iframe.contentDocument.querySelector('[data-probe="p1-button"]').click()
})
const before = await page.evaluate(() => {
  const iframe = document.querySelector('.board[data-w="390"] iframe')
  return iframe.contentDocument.querySelector('[data-probe="p1-button"]').textContent
})

// ① 改文件:label 默认值加个后缀
const t0 = Date.now()
fs.writeFileSync(FILE, orig.replace('label = "P1 纯 client"', 'label = "P1 纯 client·HMR"'))

let hmrMs = -1
try {
  await page.waitForFunction(
    () => {
      const iframe = document.querySelector('.board[data-w="390"] iframe')
      return iframe.contentDocument.body?.textContent.includes("P1 纯 client·HMR")
    },
    { timeout: 15000 }
  )
  hmrMs = Date.now() - t0
} catch { /* 超时,hmrMs 保持 -1 */ }

results.hmr = await page.evaluate(() => {
  const iframe = document.querySelector('.board[data-w="390"] iframe')
  return {
    marker: iframe.contentWindow.__no_reload_marker ?? "(丢了→发生过整页刷新)",
    counter: iframe.contentDocument.querySelector('[data-probe="p1-button"]').textContent,
  }
})
results.hmr.beforeCounter = before
results.hmr.latencyMs = hmrMs

// ② Link 逃逸测试:iframe 里点 <Link>,看导航落在哪
await page.evaluate(() => {
  const iframe = document.querySelector('.board[data-w="768"] iframe')
  iframe.contentWindow.__no_reload_marker = "alive"
  iframe.contentDocument.querySelector('[data-probe="p3-link"]').click()
})
try {
  await page.waitForFunction(
    () => {
      const iframe = document.querySelector('.board[data-w="768"] iframe')
      return iframe.contentWindow.location.pathname === "/settings"
    },
    { timeout: 10000 }
  )
} catch {}
results.link = await page.evaluate(() => {
  const iframe = document.querySelector('.board[data-w="768"] iframe')
  return {
    href: iframe.contentWindow.location.href,
    parentHref: location.href, // 外壳自己有没有被带跑
    softNav: iframe.contentWindow.__no_reload_marker === "alive", // 标记在=客户端软导航
    settingsRendered: !!iframe.contentDocument.querySelector('[data-probe="settings-title"]'),
  }
})

console.log(JSON.stringify(results, null, 2))
fs.writeFileSync(FILE, orig) // 还原
await browser.close()
