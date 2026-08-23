// 画布用的极小 DOM 工具,不引任何运行时依赖

/** 建元素:h("div", "cls", "文本") */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text !== undefined) el.textContent = text
  return el
}

/** 取必然存在的元素(骨架在 index.html 里),找不到直接抛,免得到处判空 */
export function qs<T extends Element = HTMLElement>(sel: string): T {
  const el = document.querySelector(sel)
  if (!el) throw new Error(`canvas: 缺少骨架元素 ${sel}`)
  return el as unknown as T
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** 尾部去抖 */
export function debounce<A extends unknown[]>(ms: number, fn: (...args: A) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

/** 同源 iframe 的 document,拿不到(未加载/异常)返回 null */
export function frameDoc(iframe: HTMLIFrameElement | null): Document | null {
  if (!iframe) return null
  try {
    return iframe.contentDocument
  } catch {
    return null
  }
}
