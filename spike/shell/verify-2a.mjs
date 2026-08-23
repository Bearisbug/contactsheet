// spike 2a：两条地基
//  ① iframe width=390 时 @media(max-width:430px) 真命中(390/768/1100 三块各自正确)
//  ② 外壳(父文档)能 iframe.contentDocument.elementFromPoint 反查元素(同源成立)
import { chromium } from "playwright-core"

const browser = await chromium.launch({ channel: "msedge", headless: true })
const page = await browser.newPage({ viewport: { width: 2400, height: 900 } })
await page.goto("http://localhost:5199/__loupe", { waitUntil: "networkidle" })

// 等三个 iframe 里的探针都挂出来
for (const f of page.frames()) {
  if (f === page.mainFrame()) continue
  await f.waitForSelector('[data-probe="viewport"]', { timeout: 15000 })
}

const results = { mediaQuery: {}, elementFromPoint: {}, notes: [] }

// ① 逐块读 viewport 探针的计算样式(display:none 与否),外加边框色
for (const w of ["390", "768", "1100"]) {
  results.mediaQuery[w] = await page.evaluate((w) => {
    const iframe = document.querySelector(`.board[data-w="${w}"] iframe`)
    const doc = iframe.contentDocument
    const style = (sel) =>
      getComputedStyle(doc.querySelector(sel)).display
    const border = getComputedStyle(
      doc.querySelector('[data-probe="viewport"]')
    ).borderTopColor
    return {
      wide: style('[data-probe="viewport-wide"]'),
      narrow: style('[data-probe="viewport-narrow"]'),
      borderColor: border,
      innerWidth: iframe.contentWindow.innerWidth,
    }
  }, w)
}

// ② 在 390 那块的 overlay 上对准 P1 按钮的位置发真实 mousemove,读 hud 反查结果
const btnBox = await page.evaluate(() => {
  const iframe = document.querySelector('.board[data-w="390"] iframe')
  const r = iframe.getBoundingClientRect()
  const b = iframe.contentDocument.querySelector('[data-probe="p1-button"]')
  const br = b.getBoundingClientRect()
  return { x: r.left + br.left + br.width / 2, y: r.top + br.top + br.height / 2 }
})
await page.mouse.move(btnBox.x, btnBox.y)
await page.waitForTimeout(100)
results.elementFromPoint = await page.evaluate(() => ({
  hudText: document.getElementById("hud").textContent,
  lastProbe: document.getElementById("hud").dataset.lastProbe,
  lastTag: document.getElementById("hud").dataset.lastTag,
}))

// 附带:overlay 在上面时 iframe 里的按钮不应收到 hover(浏览模式事件被截住)
const hoverLeak = await page.evaluate(() => {
  const iframe = document.querySelector('.board[data-w="390"] iframe')
  return iframe.contentDocument.querySelector('[data-probe="p1-button"]').matches(":hover")
})
results.notes.push(`overlay 截击后 iframe 内按钮 :hover = ${hoverLeak}(期望 false)`)

await page.screenshot({ path: "/tmp/cs-spike2a-wall.png", fullPage: false })
console.log(JSON.stringify(results, null, 2))
await browser.close()
