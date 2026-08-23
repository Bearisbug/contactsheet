// 贴图:paste 收图 → POST /__cs/api/refs
//
// 归属规则:批注输入框(composer)或 pin 气泡的编辑态开着时,图归**那条批注**
// (由 pins.ts 登记 pasteTarget);没有任何批注输入框在时才落到右下角的**全局**参考图坞——
// 那是"没有归属的粘贴"的兜底,不属于任何一条批注。
import { postRef, refUrl } from "./api.js"
import { h, qs } from "./dom.js"
import { setProbe } from "./hud.js"
import { toast } from "./toast.js"

let dock: HTMLDivElement
let lightbox: HTMLDivElement
let dockHead: HTMLDivElement | null = null

/** 本次会话传上去的图:path → dataURL。省一次往返,也让刚贴的图立刻能显示 */
const localSrc = new Map<string, string>()

/** 谁在接管粘贴。el 从 DOM 上摘掉即自动失效,不用在每个关闭路径上摘钩子 */
interface PasteTarget {
  el: HTMLElement
  onFile(file: File): void
}
let pasteTarget: PasteTarget | null = null

export function setPasteTarget(target: PasteTarget | null): void {
  pasteTarget = target
}

function activeTarget(): PasteTarget | null {
  if (pasteTarget && !pasteTarget.el.isConnected) pasteTarget = null
  return pasteTarget
}

export function initRefs(): void {
  dock = qs<HTMLDivElement>("#cs-refs")
  dock.title = "全局参考图:粘贴时没有开着批注输入框的图落在这里,不挂在任何一条批注上"
  lightbox = qs<HTMLDivElement>("#cs-lightbox")
  lightbox.addEventListener("click", () => {
    lightbox.hidden = true
    lightbox.textContent = ""
  })
  document.addEventListener("paste", onPaste)
}

function onPaste(e: ClipboardEvent): void {
  const items = e.clipboardData?.items
  if (!items) return
  for (const item of Array.from(items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue
    const file = item.getAsFile()
    if (!file) continue
    e.preventDefault()
    const target = activeTarget()
    if (target) target.onFile(file) // 挂到那条批注
    else void uploadToDock(file) // 没归属 → 全局坞
    return
  }
}

/** refs 数组里的"上传中"占坑值:占位符先落文字,路径后到 */
export const UPLOADING = "__uploading__"

/** 摘掉某编号之后,把更大的编号全部 -1 */
function renumberAfter(text: string, removed: number): string {
  return text.replace(/\[图片 (\d+)\]/g, (m, d) => {
    const n = Number(d)
    return n > removed ? `[图片 ${n - 1}]` : m
  })
}

/** 从文字里摘掉 [图片 n] 并把后面的编号全部 -1(和 refs 数组的 splice 同步) */
export function removeRefToken(text: string, idx1: number): string {
  return renumberAfter(text.replace(new RegExp(`\\[图片 ${idx1}\\]`, "g"), ""), idx1)
}

/** 让 [图片 n] 在 Backspace/Delete 下整体删除(Claude Code 同款原子占位符):
 *  光标贴着/在 token 里退格 = 整个 token 连同它的图一起摘掉并重编号,绝不留半截。
 *  选区碰到 token 时把选区扩到 token 边界,选中的 token 全部整体移除。 */
export function bindTokenAtomics(ta: HTMLTextAreaElement, refs: string[], redraw: () => void): void {
  ta.addEventListener("keydown", (e) => {
    if (e.key !== "Backspace" && e.key !== "Delete") return
    const tokens = [...ta.value.matchAll(/\[图片 (\d+)\]/g)].map((m) => ({
      n: Number(m[1]),
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    }))
    if (tokens.length === 0) return
    const s = ta.selectionStart ?? 0
    const t = ta.selectionEnd ?? s

    const dropRefs = (nums: number[]): void => {
      // 按编号从大到小摘,splice 的下标才不会互相踩
      for (const n of [...nums].sort((a, b) => b - a)) {
        refs.splice(n - 1, 1)
        ta.value = renumberAfter(ta.value, n)
      }
      redraw()
    }

    if (s === t) {
      // 折叠光标:Backspace 吃左边,命中 (start, end];Delete 吃右边,命中 [start, end)
      const hit = tokens.find((k) => (e.key === "Backspace" ? s > k.start && s <= k.end : s >= k.start && s < k.end))
      if (!hit) return
      e.preventDefault()
      ta.setRangeText("", hit.start, hit.end, "start")
      dropRefs([hit.n])
      ta.setSelectionRange(hit.start, hit.start)
      return
    }
    // 有选区:被碰到的 token 全部整体删,选区其余文本照删
    const touched = tokens.filter((k) => k.start < t && k.end > s)
    if (touched.length === 0) return
    e.preventDefault()
    const ns = Math.min(s, ...touched.map((k) => k.start))
    const ne = Math.max(t, ...touched.map((k) => k.end))
    ta.setRangeText("", ns, ne, "start")
    dropRefs(touched.map((k) => k.n))
    ta.setSelectionRange(ns, ns)
  })
}

/** 光标处插入占位符(Claude Code 同款:图片在文字里有位置) */
function insertAtCursor(ta: HTMLTextAreaElement, token: string): void {
  const start = ta.selectionStart ?? ta.value.length
  const end = ta.selectionEnd ?? start
  ta.setRangeText(token, start, end, "end")
  ta.dispatchEvent(new Event("input", { bubbles: true }))
}

/**
 * 粘贴一张图到 (textarea, refs):立刻在光标处插 [图片 n] 并在 refs 占坑,
 * 上传完成回填路径;失败摘掉占位符并重编号。n = 粘贴顺序,不随文字里的位置变。
 * (两张图并发粘贴且第一张失败时,第二张的坑位会前移 —— 顺序粘贴不受影响,接受这个边界)
 */
export function attachInline(
  ta: HTMLTextAreaElement,
  refs: string[],
  file: File,
  redraw: () => void
): void {
  const n = refs.length + 1
  refs.push(UPLOADING)
  insertAtCursor(ta, `[图片 ${n}]`)
  redraw()
  void uploadRef(file)
    .then((path) => {
      refs[n - 1] = path
      redraw()
    })
    .catch((err) => {
      refs.splice(n - 1, 1)
      ta.value = removeRefToken(ta.value, n)
      redraw()
      toast(`参考图上传失败:${String(err)}`, "error")
    })
}

/** 上传一张图,返回 repo 相对路径(失败抛) */
export async function uploadRef(file: File): Promise<string> {
  const dataUrl = await readDataUrl(file)
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1)
  const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg")
  const name = file.name || `paste-${Date.now()}.${ext}`
  setProbe(`上传参考图 ${name}…`)
  const { path } = await postRef(name, base64)
  localSrc.set(path, dataUrl)
  return path
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error("读图失败"))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(file)
  })
}

/** 显示地址:本次会话传过的直接用 dataURL,其余走外壳的取图路由 */
export function refSrc(path: string): string {
  return localSrc.get(path) ?? refUrl(path)
}

/** 参考图缩略图:占位符样式(「图片 n」+ 小缩略图),点开大图,可带删除钮。
 *  取不到图时退化成文件名 chip(不留破图标) */
export function refThumb(
  path: string,
  opts?: { index?: number; onRemove?: () => void }
): HTMLElement {
  const card = h("div", "cs-ref-thumb")
  card.title = path
  const img = h("img")
  const broken = (): void => {
    img.hidden = true
    card.classList.add("is-broken")
  }
  img.addEventListener("error", broken)
  img.alt = path
  img.src = refSrc(path)
  // 已解码完成的图(dataURL/缓存)不会再补发 error 事件,同步补测一次
  if (img.complete && img.naturalWidth === 0) broken()
  card.append(img, h("span", "cs-ref-name", opts?.index ? `图片 ${opts.index}` : fileOf(path)))
  card.addEventListener("click", (e) => {
    e.stopPropagation() // 别顺带把 pin 选中/把气泡当成点了别处
    openLightbox(refSrc(path), path)
  })
  if (opts?.onRemove) {
    const rm = h("button", "cs-ref-rm", "✕")
    rm.title = "从这条批注移除(文件保留在 refs/)"
    rm.setAttribute("aria-label", rm.title)
    rm.addEventListener("click", (e) => {
      e.stopPropagation()
      opts.onRemove?.()
    })
    card.appendChild(rm)
  }
  return card
}

export function openLightbox(src: string, caption: string): void {
  lightbox.textContent = ""
  const big = h("img")
  big.src = src
  big.alt = caption
  lightbox.append(big, h("span", undefined, caption))
  lightbox.hidden = false
}

function fileOf(path: string): string {
  return path.split("/").pop() ?? path
}

// ---------- 全局坞(没有归属的粘贴) ----------

async function uploadToDock(file: File): Promise<void> {
  try {
    const path = await uploadRef(file)
    addThumb(path)
    toast(
      `参考图已存:${path} —— 这是全局参考图,没挂在批注上。要挂到某条批注:按 c 写批注时粘贴,或在 pin 气泡里点「编辑」后粘贴`,
      "ok"
    )
  } catch (err) {
    toast(`参考图上传失败:${String(err)}`, "error")
  }
}

function addThumb(path: string): void {
  ensureDockHead()
  const card = h("div", "cs-ref")
  const img = h("img")
  img.src = refSrc(path)
  img.alt = path
  card.append(img, h("span", undefined, fileOf(path)))
  card.title = `${path}(全局参考图,不属于任何批注)`
  card.addEventListener("click", () => openLightbox(refSrc(path), path))
  dock.appendChild(card)
}

/** 坞的标题:说清楚这一列是全局的。坞是 column-reverse,首个子节点显示在最下面 */
function ensureDockHead(): void {
  if (dockHead) return
  dockHead = h("div", "cs-refs-head", "全局参考图 · 未挂到批注")
  dockHead.title = "粘贴时没有开着批注输入框的图落在这里。要挂到某条批注:按 c 写批注时粘贴,或在 pin 气泡里点「编辑」后粘贴"
  dock.insertBefore(dockHead, dock.firstChild)
}
