// ============================================================
// [Agent B] 注入到用户 Next 项目的文件模板
// 本仓库 tsconfig 不编译 JSX,所以全部以模板字符串形式存放。
// 一律用 String.raw:模板里出现的反斜杠(如 "\\u003c")原样落到生成文件,
// 只有 ${...} 会被替换 —— 生成的代码里不要出现反引号和其它 ${。
// ============================================================

/** design/__generated__/registry 里的一条 import 描述 */
export interface RegistryItem {
  /** 模块变量名 m0 / m1 … */
  varName: string
  /** 相对 __generated__ 目录的 import 说明符,如 "../Button.artboard" */
  importPath: string
  /** modules / files 的 key,即 fileSlug */
  slug: string
  /** repo 相对路径,如 "design/Button.artboard.tsx" */
  file: string
}

const HEADER = "// 由 contactsheet 自动生成 —— 请勿编辑,下次启动会被覆盖\n"

/** <appDir>/%5F%5Fcs/ab/[id]/page.tsx —— 画板路由(server component) */
export function pageTemplate(registryImport: string): string {
  return (
    HEADER +
    String.raw`import { Suspense } from "react"
import { notFound } from "next/navigation"
import { modules } from "${registryImport}"
import { CsErrorBoundary, CsErrorCard } from "./boundary"

// 类型一律用 any:不依赖用户项目的 Next typegen(PageProps<"..."> 要求 .next/types 已生成)

// Next 16 的 params 不解码百分号转义(实测 params.id = "Button--%E9%BB%98%E8%AE%A4"),这里自己解
function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw // 文件名里真带 % 时 decode 会抛,退回原串
  }
}

// id = fileSlug + "--" + exportName;exportName 不含 "-",所以按最后一个 "--" 切
function lookupEntry(id: string): any {
  const i = id.lastIndexOf("--")
  if (i <= 0) return null
  const mod: any = (modules as any)[id.slice(0, i)]
  if (!mod) return null
  return mod[id.slice(i + 2)] ?? null
}

// ?args= 是 encodeURIComponent(JSON.stringify(args)),Next 已解码一层,这里只需 JSON.parse
function parseArgs(raw: any): any {
  if (typeof raw !== "string" || raw.length === 0) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}

// 默认无底色(裸放画布);底色由外壳按每板开关注入(大部分组件自带 surface,无底色的一键切换)
// 不留内边距:wrapper 一旦有 padding,组件的高亮框就永远比可见的白底小一圈(实测 390 宽的板
// 四周各差 16px),两者对不齐。留白交给组件自己,画板的底就等于组件的盒子。
const wrap: any = {}
// 提示与错误卡不是被审视的组件,贴边反而挤,单独留内边距
const padded: any = { padding: 16 }
const hint: any = { font: "13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace", color: "#666" }
const loading: any = { font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace", opacity: 0.5 }

export default async function Page(props: any) {
  if (process.env.NODE_ENV === "production") notFound() // 生产构建里这条路不存在
  const params: any = await props.params
  const searchParams: any = await props.searchParams
  const id: string = decodeId(String(params?.id ?? ""))
  const entry: any = lookupEntry(id)
  if (!entry) notFound()

  const kind: string = typeof entry.url === "string" ? "screen" : "component"
  const args: any = { ...(entry.args ?? {}), ...parseArgs(searchParams?.args) }
  // 转义 "<" 防止 args 里的字符串提前闭合 script 标签(JSON 里 < 解析回 "<")
  const meta: string = JSON.stringify({ id, args, env: entry.env, kind }).replace(/</g, "\\u003c")
  const metaTag = <script type="application/json" id="__cs_meta" dangerouslySetInnerHTML={{ __html: meta }} />

  // 页面画板由外壳直接 iframe 目标 url,不在这条路由渲染
  if (kind === "screen") {
    return (
      <div data-cs-artboard={id} style={padded}>
        {metaTag}
        <p style={hint}>页面画板:请直接打开 {entry.url}</p>
      </div>
    )
  }

  if (typeof entry.render !== "function") {
    return (
      <div data-cs-artboard={id} style={padded}>
        {metaTag}
        <CsErrorCard name={id} error="画板既没有 render(args) 也没有 url" />
      </div>
    )
  }

  // render 自己同步抛错时 ErrorBoundary 够不着,这里兜一层
  let node: any = null
  try {
    node = entry.render(args)
  } catch (err: any) {
    return (
      <div data-cs-artboard={id} style={padded}>
        {metaTag}
        <CsErrorCard name={id} error={String(err?.message ?? err)} />
      </div>
    )
  }

  // 没声明 env.width 的组件画板收缩到内容宽(shrink-wrap),外壳按它定 iframe 宽 —— "裸放在画布上"
  const wrapStyle: any = entry.env && entry.env.width ? wrap : { ...wrap, width: "fit-content" }

  return (
    <div data-cs-artboard={id} style={wrapStyle}>
      {metaTag}
      <CsErrorBoundary name={id}>
        <Suspense fallback={<div style={loading}>loading…</div>}>{node}</Suspense>
      </CsErrorBoundary>
    </div>
  )
}
`
  )
}

/** <appDir>/%5F%5Fcs/ab/[id]/boundary.tsx —— 画板崩溃时显示红色虚线错误卡 */
export function boundaryTemplate(): string {
  return (
    HEADER +
    String.raw`"use client"
import React from "react"

const cardStyle: any = {
  border: "1px dashed #e5484d",
  borderRadius: 6,
  background: "#fff5f5",
  color: "#c62a2f",
  padding: "10px 12px",
  font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
}

export function CsErrorCard(props: any) {
  return (
    <div style={cardStyle} data-cs-error="1">
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{props.name}</div>
      <div>{props.error}</div>
    </div>
  )
}

export class CsErrorBoundary extends React.Component<any, any> {
  constructor(props: any) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: any) {
    return { error: String(error?.message ?? error) }
  }
  render() {
    if (this.state.error) return <CsErrorCard name={this.props.name} error={this.state.error} />
    return this.props.children
  }
}
`
  )
}

/** <appDir>/%5F%5Fcs/registry/route.ts —— GET 返回 RegistryEntry[] */
export function routeTemplate(registryImport: string): string {
  return (
    HEADER +
    String.raw`import { modules, files } from "${registryImport}"

// 不要加 export const dynamic = "force-dynamic":它与 Next 16 的 cacheComponents 互斥,
// 用户开了那个配置会让 registry/ab/tokens 三条路由同时 500,且报错指向用户自己的 next.config。
// dev 下 route handler 本来就不缓存,production 下这条路由直接 404,加它没有收益。

// GET /__cs/registry → RegistryEntry[];kind 在这里判真值:有 url 是 screen,有 render 是 component
export async function GET() {
  if (process.env.NODE_ENV === "production") return new Response("Not Found", { status: 404 })

  const entries: any[] = []
  for (const slug of Object.keys(modules as any)) {
    const mod: any = (modules as any)[slug]
    if (!mod) continue
    for (const exportName of Object.keys(mod)) {
      const v: any = mod[exportName]
      if (!v || typeof v !== "object") continue
      // 没有 render 也没有 url 的对象照样进注册表(按 component):墙上出错误卡,
      // 而不是静默消失 —— 用户把 render 敲错时必须有反馈
      const kind = typeof v.url === "string" ? "screen" : "component"
      entries.push({
        id: slug + "--" + exportName,
        file: (files as any)[slug] ?? "",
        exportName,
        kind,
        args: v.args,
        env: v.env,
        url: v.url,
      })
    }
  }
  return Response.json(entries)
}
`
  )
}

/** <appDir>/%5F%5Fcs/tokens/page.tsx —— 设计变量总览(client) */
export function tokensTemplate(): string {
  return (
    HEADER +
    String.raw`"use client"
import { useEffect, useState } from "react"

type Token = { name: string; value: string }

// 枚举同源样式表里 :root / :host / html 下的自定义属性
// (Tailwind v4 的 @theme 编译后就是 @layer theme 里的 ":root, :host",靠递归 cssRules 拿到)
function collectTokens(): Token[] {
  const found = new Map<string, string>()
  const visit = (rules: any) => {
    if (!rules) return
    for (let i = 0; i < rules.length; i++) {
      const rule: any = rules[i]
      if (rule.cssRules) visit(rule.cssRules)
      const style: any = rule.style
      if (!style) continue
      const sel: string = typeof rule.selectorText === "string" ? rule.selectorText : ""
      if (sel && !/:root|:host|(^|,)\s*html\b/.test(sel)) continue
      for (let k = 0; k < style.length; k++) {
        const prop: string = style[k]
        if (prop && prop.slice(0, 2) === "--") found.set(prop, String(style.getPropertyValue(prop)).trim())
      }
    }
  }
  for (let i = 0; i < document.styleSheets.length; i++) {
    try {
      visit((document.styleSheets[i] as any).cssRules)
    } catch {
      // 跨域样式表读不到 cssRules,跳过
    }
  }
  return Array.from(found, ([name, value]) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name))
}

// 值本身就是颜色的(shadcn 的 --primary / --background 这些没有 --color- 前缀)也给方块
function isColorValue(v: string): boolean {
  return /^(#|rgba?\(|hsla?\(|hwb\(|lab\(|lch\(|oklab\(|oklch\(|color\()/i.test(v)
}

const mono = "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace"
const page: any = { padding: 24, font: mono, color: "#111", background: "#fff", minHeight: "100vh" }
const h2: any = { font: "600 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace", margin: "24px 0 10px", color: "#555" }
const grid: any = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12 }
const cell: any = { border: "1px solid #eee", borderRadius: 6, padding: 10, overflow: "hidden" }
const nameStyle: any = { fontWeight: 600, wordBreak: "break-all" }
const valueStyle: any = { color: "#888", wordBreak: "break-all" }

function Cell(props: any) {
  return (
    <div style={cell}>
      {props.children}
      <div style={nameStyle}>{props.token.name}</div>
      <div style={valueStyle}>{props.token.value}</div>
    </div>
  )
}

function Group(props: any) {
  if (props.tokens.length === 0) return null
  return (
    <section>
      <h2 style={h2}>
        {props.title} · {props.tokens.length}
      </h2>
      <div style={grid}>
        {props.tokens.map((t: Token) => (
          <Cell key={t.name} token={t}>
            {props.kind === "color" || isColorValue(t.value) ? (
              <div
                style={{
                  height: 44,
                  marginBottom: 8,
                  borderRadius: 4,
                  border: "1px solid rgba(0,0,0,.1)",
                  background: "var(" + t.name + ")",
                }}
              />
            ) : null}
            {props.kind === "radius" ? (
              <div
                style={{
                  height: 44,
                  marginBottom: 8,
                  border: "1px solid #ddd",
                  background: "#f6f6f6",
                  borderRadius: "var(" + t.name + ")",
                }}
              />
            ) : null}
          </Cell>
        ))}
      </div>
    </section>
  )
}

export default function TokensPage() {
  const [tokens, setTokens] = useState<Token[]>([])
  useEffect(() => {
    setTokens(collectTokens())
  }, [])

  if (process.env.NODE_ENV === "production") return null // 生产里这页不出现

  const pick = (p: string) => tokens.filter((t) => t.name.indexOf(p) === 0)
  const known = ["--color-", "--radius-", "--font-", "--spacing-"]
  const rest = tokens.filter((t) => !known.some((p) => t.name.indexOf(p) === 0))

  return (
    <main style={page}>
      <div style={{ font: mono, color: "#888" }}>contactsheet · design tokens · 共 {tokens.length} 个自定义属性</div>
      {tokens.length === 0 ? (
        <p style={{ color: "#888", marginTop: 16 }}>没读到自定义属性(样式表可能还没加载完,或都是跨域的)。</p>
      ) : null}
      <Group title="颜色 --color-*" kind="color" tokens={pick("--color-")} />
      <Group title="圆角 --radius-*" kind="radius" tokens={pick("--radius-")} />
      <Group title="字体 --font-*" kind="text" tokens={pick("--font-")} />
      <Group title="间距 --spacing-*" kind="text" tokens={pick("--spacing-")} />
      <Group title="其它" kind="text" tokens={rest} />
    </main>
  )
}
`
  )
}

/** <designDir>/__generated__/registry.tsx —— watcher 生成的画板索引 */
export function registryTemplate(items: RegistryItem[]): string {
  const imports = items.map((it) => 'import * as ' + it.varName + ' from "' + it.importPath + '"').join("\n")
  const mods = items.map((it) => '  "' + it.slug + '": ' + it.varName + ",").join("\n")
  const fileMap = items.map((it) => '  "' + it.slug + '": "' + it.file + '",').join("\n")
  return (
    "// 由 contactsheet 自动生成 —— 请勿编辑,画板文件增删改后会被重写\n" +
    (imports ? imports + "\n\n" : "") +
    "export const modules: Record<string, Record<string, unknown>> = " +
    (items.length ? "{\n" + mods + "\n}\n" : "{}\n") +
    "\n// fileSlug → repo 相对路径,给 /__cs/registry 填 RegistryEntry.file\n" +
    "export const files: Record<string, string> = " +
    (items.length ? "{\n" + fileMap + "\n}\n" : "{}\n")
  )
}
