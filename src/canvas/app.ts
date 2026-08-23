// contactsheet 画布入口:拉状态建墙、连 SSE、装配各模块
// 行为规格见 CONTRACTS.md「画布(Agent C)行为规格」
import type { Annotation, RegistryEntry } from "../types.js"
import { connectEvents, fetchAnnotations, fetchRegistry, fetchState } from "./api.js"
import { h, qs } from "./dom.js"
import { initHud } from "./hud.js"
import { initArgsPanel } from "./args-panel.js"
import { initModes } from "./modes.js"
import { copyContext, initPins, pushToClaudeCode, renderPins } from "./pins.js"
import { initRefs } from "./refs.js"
import { initSelect, refreshBoxes } from "./select.js"
import { state } from "./state.js"
import { initView, onViewChange, restoreView } from "./view.js"
import { initSidebar, syncActive } from "./sidebar.js"
import { initWall, mountVisible, remeasureAll, syncEntries } from "./wall.js"
import { hideUnhealthy, setLastOk, showUnhealthy } from "./health-banner.js"

function showBootError(err: unknown): void {
  const boot = qs("#cs-boot")
  boot.textContent = ""
  const card = h("div", "cs-card")
  // 三种情况必须分开说,否则用户往错误的方向排查:
  // 502/504 = 我们的代理连不上目标(dev server 没起,或起在别的端口 —— target 配错是重灾区);
  // 其余 5xx = 目标活着但注册表模块炸了(几乎总是某个画板文件有编译错误);
  // 非 HTTP = 连外壳自己都没连上。
  const msg = String(err)
  const target = state.info?.target ?? "http://localhost:3000"
  if (/HTTP 50[24]/.test(msg)) {
    card.appendChild(h("h2", undefined, "连不上你的 dev server"))
    card.appendChild(
      h("p", undefined, `外壳正把请求代理到 ${target},但那里没有响应。两种可能:dev server 还没起;或它跑在别的端口(去 package.json 的 dev script 看真实端口,改 contactsheet.config.json 的 target,或重启时加 --target)。`)
    )
    const p = h("p")
    p.appendChild(h("code", undefined, "pnpm dev"))
    card.appendChild(p)
  } else if (/HTTP 5\d\d/.test(msg)) {
    card.appendChild(h("h2", undefined, "画板文件编译错误"))
    card.appendChild(
      h("p", undefined, "next dev 在跑,但画板注册表模块渲染失败 —— 通常是某个 *.artboard.tsx 有语法或 import 错误。去 next dev 的终端看具体报错,修好后这面墙会自动恢复。")
    )
  } else {
    card.appendChild(h("h2", undefined, "目标 dev server 未启动"))
    card.appendChild(h("p", undefined, "画布连不上画板数据。先在项目里起 next dev,墙会自动恢复。"))
    const p = h("p")
    p.appendChild(h("code", undefined, "pnpm dev"))
    card.appendChild(p)
  }
  card.appendChild(h("div", "cs-err", String(err)))
  card.appendChild(h("p", "cs-dim", "每 3 秒自动重试中…"))
  const btn = h("button", undefined, "立即重试")
  btn.addEventListener("click", () => void tryLoadRegistry())
  card.appendChild(btn)
  boot.appendChild(card)
  boot.hidden = false
}

let retryTimer: ReturnType<typeof setInterval> | null = null

/** 拉注册表:成功就建墙并收掉错误卡;失败展示原因并保持每 3 秒重试(修好画板文件后墙自动复活) */
async function tryLoadRegistry(): Promise<boolean> {
  try {
    const reg = await fetchRegistry()
    syncEntries(reg)
    remeasureAll()
    renderPins()
    qs("#cs-boot").hidden = true
    if (retryTimer !== null) {
      clearInterval(retryTimer)
      retryTimer = null
    }
    return true
  } catch (err) {
    showBootError(err)
    if (retryTimer === null) retryTimer = setInterval(() => void tryLoadRegistry(), 3000)
    return false
  }
}

function showTarget(): void {
  const info = state.info
  const el = qs("#cs-target")
  el.textContent = info ? `${info.target} · ${info.designDir}` : ""
  el.title = info ? `v${info.version} · ${info.projectRoot}` : ""
}

/** SSE registry 事件:统一走 tryLoadRegistry(权威数据 + 失败时错误卡/重试,不拿残缺条目建墙)。
 *  但 SSE 比 Next 重编译快约 1 秒:事件到达时 /__cs/registry 往往还是旧的那份,只拉一次就停,
 *  新画板会一直卡到下次文件变动或手动刷新。拿 SSE 报的 id 集合当预期,对不上就短间隔再拉几次。 */
function onRegistryEvent(entries: RegistryEntry[]): void {
  void reloadUntilMatches(entries.map((e) => e.id))
}

async function reloadUntilMatches(wantIds: string[], tries = 4): Promise<void> {
  const want = new Set(wantIds)
  for (let i = 0; i < tries; i++) {
    if (!(await tryLoadRegistry())) return // 已经进错误卡 + 3 秒重试,别再叠一层轮询
    const got = new Set(state.entries.map((e) => e.id))
    if (got.size === want.size && [...want].every((id) => got.has(id))) return
    await new Promise((r) => setTimeout(r, 700))
  }
}

function onAnnotations(list: Annotation[]): void {
  state.annotations = list
  renderPins()
}

async function boot(): Promise<void> {
  initView()
  initSelect()
  initHud()
  initPins()
  initArgsPanel()
  initWall()
  initSidebar()
  initModes()
  initRefs()
  onViewChange(refreshBoxes)
  // 视图停下来之后补挂:低缩放时 IO 会跳过挂载,放大回来要把可见的补上
  let mountTimer: ReturnType<typeof setTimeout> | null = null
  onViewChange(() => {
    if (mountTimer !== null) clearTimeout(mountTimer)
    mountTimer = setTimeout(mountVisible, 180)
  })
  qs("#cs-copy").addEventListener("click", () => void copyContext())
  qs("#cs-push").addEventListener("click", () => void pushToClaudeCode())

  // 外壳自己的接口(state)拉不到才是致命错(页面就是外壳发的,几乎不可能)
  try {
    state.info = await fetchState()
  } catch (err) {
    showBootError(err)
    return
  }
  showTarget()
  restoreView() // info 就位后按项目键恢复上次的位置与缩放

  // 健康快照要抢在拉注册表**之前**:目标僵死时注册表请求会被吊死,横幅不能陪它一起等
  try {
    const hres = await fetch("/__cs/api/health")
    const hstate = (await hres.json()) as { ok: boolean; detail?: string; lastOkAt?: number }
    setLastOk(hstate.lastOkAt)
    if (!hstate.ok) showUnhealthy(hstate.detail)
  } catch {
    /* 外壳自己都挂了的话,fetchState 的错误卡已经在说话 */
  }

  // SSE 要抢在拉注册表之前连上:僵死期注册表请求会吊到超时,健康恢复事件不能陪它等
  connectEvents({
    registry: onRegistryEvent,
    annotations: onAnnotations,
    health: (ok, detail) => {
      if (ok) {
        setLastOk(Date.now())
        hideUnhealthy()
      } else {
        showUnhealthy(detail)
      }
    },
  })

  // 注册表失败不终止启动:错误卡 + 自动重试 —— 画板文件修好后墙自动复活
  await tryLoadRegistry()

  try {
    state.annotations = await fetchAnnotations()
    renderPins()
  } catch {
    /* 批注拉不到不算致命,墙照常用 */
  }
}

void boot()
