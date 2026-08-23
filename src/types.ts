// ============================================================
// contactsheet 全局共享类型 —— 冻结契约,五个模块都 import 这里
// 改这个文件 = 改契约,只有集成负责人(主会话)可以动
// ============================================================

/** 运行配置,来自 contactsheet.config.json + CLI flags 合并 */
export interface CsConfig {
  /** 用户项目根(绝对路径) */
  projectRoot: string
  /** 用户 next dev 地址,默认 http://localhost:3000 */
  target: string
  /** 外壳端口,默认 5199 */
  port: number
  /** 监听地址,默认 127.0.0.1(仅本机)。设成 0.0.0.0 会让同网络可达,无鉴权,慎用 */
  host?: string
  /** app 目录相对路径:"app" 或 "src/app" */
  appDir: string
  /** 画板目录相对路径,默认 "design" */
  designDir: string
}

export interface ArtboardEnv {
  /** 画板 iframe 宽度 px,默认 480 */
  width?: number
  /** 固定高度 px;缺省时外壳自动测内容高 */
  height?: number
  theme?: "light" | "dark"
}

/** 注册表条目 —— /__cs/registry(Next 内路由)返回 RegistryEntry[] */
export interface RegistryEntry {
  /** `${fileSlug}--${exportName}`;fileSlug = designDir 下相对路径去掉 .artboard.tsx?,"/"→"__" */
  id: string
  /** repo 相对路径,如 "design/Button.artboard.tsx" */
  file: string
  exportName: string
  /** component = 有 render 的组件画板;screen = 有 url 的页面画板 */
  kind: "component" | "screen"
  /** 组件画板声明的默认 args(可被 ?args= 覆盖) */
  args?: Record<string, unknown>
  env?: ArtboardEnv
  /** screen 专用:目标页面路径,如 "/dashboard" */
  url?: string
}

/** 用户此刻指着谁 —— 内存态,不落盘 */
export interface Selection {
  artboardId: string
  /** 画板文档内的 CSS selector */
  selector: string
  /** 相对被选元素的 0-1 坐标 */
  x: number
  y: number
  /** Date.now() */
  ts: number
}

/** 批注 —— 落盘到 design/.canvas/annotations.json
 *  生命周期:open(待处理,橙) → resolved(Claude 标记完成,绿·待核验) → verified(人工核验,从墙上消失)。
 *  verified 不删除 —— annotations.json 就是历史记录,后续沉淀 skill 的原料;硬删除只留给误钉。 */
export interface Annotation {
  id: string
  /** 项目内永久序号:创建时分配,全墙唯一,核验/删除都不改号,不复用。
   *  pin 圆点、推送/复制给 Claude 的文本用的都是它 —— 人和 Claude 说"批注 3"指的是同一条 */
  seq?: number
  artboardId?: string
  anchor?: { selector: string; x: number; y: number }
  text: string
  /** repo 相对路径,如 "design/.canvas/refs/2026-08-22-linear.png" */
  refs: string[]
  status: "open" | "resolved" | "verified"
  /** ISO 字符串 */
  createdAt: string
  /** 标记完成时间(status→resolved 时由客户端盖章) */
  resolvedAt?: string
  /** 人工核验时间(status→verified 时盖章) */
  verifiedAt?: string
}

/** SSE 事件(GET /__cs/events, text/event-stream) */
export type CsEvent =
  | { type: "registry"; entries: RegistryEntry[] }
  | { type: "annotations"; annotations: Annotation[] }

/** 截图请求/结果 */
export interface ShotRequest {
  /** 画板 id;缺省 = 整面墙 */
  id?: string
  /** 覆盖 args(仅组件画板) */
  args?: Record<string, unknown>
}
export interface ShotResult {
  /** repo 相对路径 design/.canvas/shots/<name>.png */
  path: string
  base64: string
  width: number
  height: number
}

/** GET /__cs/api/state 的返回 */
export interface StateInfo {
  version: string
  target: string
  designDir: string
  projectRoot: string
}
