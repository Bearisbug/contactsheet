// 画布的全局可变状态 —— 只放数据,不 import 其它画布模块(避免环)
import type { Annotation, RegistryEntry, Selection, StateInfo } from "../types.js"

export type Mode = "browse" | "interact" | "review"

/** 一块画板的运行时对象 */
export interface Board {
  entry: RegistryEntry
  /** 外层 .cs-board */
  el: HTMLDivElement
  titleEl: HTMLDivElement
  nameEl: HTMLSpanElement
  badgeEl: HTMLSpanElement
  argsCountEl: HTMLSpanElement
  /** .cs-frame,尺寸写在它身上 */
  frameEl: HTMLDivElement
  overlayEl: HTMLDivElement
  pinLayerEl: HTMLDivElement
  placeholderEl: HTMLDivElement
  iframe: HTMLIFrameElement | null
  width: number
  height: number
  /** 用户在 args 面板改过的 args;null = 用画板自己的默认值 */
  argsOverride: Record<string, unknown> | null
}

export const state = {
  info: null as StateInfo | null,
  entries: [] as RegistryEntry[],
  boards: new Map<string, Board>(),
  /** file → 该组内画板 id 的稳定顺序(已有 id 不动,新 id 排组尾) */
  order: new Map<string, string[]>(),
  annotations: [] as Annotation[],

  mode: "browse" as Mode,
  /** 进走查前的模式,Esc 逐级退回 */
  modeBeforeReview: "browse" as Mode,
  /** 走查前的视图,退出时还原 */
  viewBeforeReview: null as { scale: number; tx: number; ty: number } | null,

  /** 当前活动画板(hover/点击/双击都会更新),Enter 走查的就是它 */
  activeId: null as string | null,
  selection: null as Selection | null,
  /** 按了 c、等着点元素落 pin */
  pinPending: false,
  pinnedThisRun: 0,

  scale: 1,
  tx: 284, // 给左侧栏让位(侧栏 236 + 边距)
  ty: 48,
}
