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
