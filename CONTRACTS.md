# CONTRACTS —— contactsheet 模块契约(冻结)

所有并行实现的 agent **先读完本文件再动手**。本文件与 `src/types.ts`、`package.json`、`tsconfig.json`、`build.mjs` 是冻结件,任何 agent 不得修改;需要新依赖或改契约,写进自己的完成报告,由集成负责人处理。

## 产品一句话

`npx contactsheet` 附着到一个 Next.js repo:`:5199` 起外壳,反代用户的 `next dev :3000`,往用户 app 注入一条画板路由,把 `design/**/*.artboard.tsx` 的每个 export 摊在一面可缩放的墙上。画布是视图不是文档:一切状态在 repo 文件里,画布可随时推倒重建。

## 已验证事实(spike 结论,不要重新怀疑)

- 渲染后端只有一个:用户自己的 next dev。画板路由是注入的 `app/%5F%5Fcs/ab/[id]/page.tsx`(下划线开头目录是 App Router private folder,文件夹名必须用 `%5F` 转义)。
- 反挂:外壳只占 `/__cs` 前缀,其余全代理(含 `/_next/*` 与 HMR WebSocket,http-proxy `ws:true` 实测可过,`changeOrigin:true` 留作保险)。
- iframe width=390 时 `@media(max-width:430px)` 真命中;同源下外壳可 `iframe.contentDocument.elementFromPoint`。
- 动态 `[id]` 路由只编译一次,10 块画板 469ms 全出画;HMR 穿代理 ~406ms 且 React state 不丢。
- 注入路由要配 `devIndicators: false` 不可行(那是用户 next.config 的事,不动),改为文档说明;画板页面自身尽量干净。
- 本机 curl 测试必须 `--noproxy '*'`(用户挂着 Clash)。

## 文件所有权(硬边界,禁止越界写文件)

| 归属 | 路径 |
|---|---|
| 集成负责人(勿动) | `package.json` `tsconfig.json` `build.mjs` `CONTRACTS.md` `src/types.ts` `spike/**` |
| Agent A core-server | `src/cli.ts` `src/config.ts` `src/server/**` |
| Agent B inject-watch | `src/inject/**` `src/watch/**` |
| Agent C canvas-ui | `src/canvas/**` |
| Agent D mcp-shot | `src/mcp/**` `src/shot/**` |
| Agent E init | `src/init/**` `README.md` |

跨模块只允许 import:`src/types.ts` + 下面「模块入口签名」列出的入口文件。stub 已建好,签名不许改,替换实现即可。仓库必须随时 `pnpm exec tsc --noEmit` 全绿(别人的 stub 就是为此存在的)。

## URL 空间(外壳 :5199)

| 路径 | 谁处理 | 说明 |
|---|---|---|
| `/__cs` | 外壳 | 画布 index.html |
| `/__cs/ui/*` | 外壳 | 静态资产:`dist/canvas/` 下的 app.js / style.css(开发期从 `src/canvas` 直读见 Agent A 注释) |
| `/__cs/api/state` | 外壳 | GET → `StateInfo` |
| `/__cs/api/selection` | 外壳 | GET → `Selection\|null`;POST `Selection` → 204。内存态 |
| `/__cs/api/annotations` | 外壳 | GET → `Annotation[]`;POST(不带 id,服务端生成)→ 201 返回完整对象;PATCH `/__cs/api/annotations/:id`(部分字段)→ 200;DELETE → 204。落盘 `design/.canvas/annotations.json`,变更后推 SSE |
| `/__cs/api/refs` | 外壳 | POST `{name:string, dataBase64:string}` → `{path:string}`,存 `design/.canvas/refs/`,文件名 `YYYY-MM-DD-<name>` 防撞 |
| `/__cs/api/refs/<repo 相对路径>` | 外壳 | GET → 图片字节。路径 resolve 后必须落在 `<designDir>/.canvas/refs/` 内,否则 404(防穿越) |
| `/__cs/api/context` | 外壳 | GET → `text/plain`:open 批注 + 当前 selection 的人类可读摘要,给 UserPromptSubmit hook 用;都为空时返回空 body |
| `/__cs/api/screenshot` | 外壳 | POST `ShotRequest` → `ShotResult`(调 Agent D 的 shot 模块) |
| `/__cs/events` | 外壳 | SSE,`CsEvent`,事件名 = type 字段,data = JSON |
| `/__cs/mcp` | 外壳→D | MCP streamable http handler |
| `/__cs/ab/*` `/__cs/registry` `/__cs/tokens` | **代理→Next** | 注入路由,外壳直接放行 |
| 其余一切(含 WS) | 代理→Next | |

## artboard 文件约定

```tsx
// design/Button.artboard.tsx —— 组件画板(.tsx)
import { Button } from '@/components/ui/button'
export const 默认 = {
  render: (args: any) => <Button {...args}>保存</Button>,
  args: { variant: 'default', disabled: false },   // 可选
  env: { width: 390 },                             // 可选
}
```

```ts
// design/screens.artboard.ts —— 页面画板(.ts,无 jsx)
export const 仪表盘 = { url: '/dashboard', env: { width: 1440 } }
```

- 扫描范围:`<designDir>/**/*.artboard.{tsx,ts}`,忽略 `__generated__`。
- export 名提取用正则 `^export\s+const\s+([\p{L}\w$]+)`(v1 接受其局限)。
- id 规则见 `types.ts` 注释。URL 里出现时 `encodeURIComponent`。

## 注入的 Next 文件(Agent B 生成,全部进用户 .gitignore)

1. `<appDir>/%5F%5Fcs/ab/[id]/page.tsx` —— server component:
   - `NODE_ENV==='production'` → `notFound()`
   - 从 registry 找 id,`?args=<encodeURIComponent(JSON)>` 浅合并覆盖默认 args,调 `render(args)`
   - 包一层 ErrorBoundary(client 组件,内联在同目录 `boundary.tsx`),崩溃画板显示错误卡而不是白屏
   - 输出 `<script type="application/json" id="__cs_meta">{JSON.stringify({id,args,env,kind})}</script>` 供外壳读
   - screen 类型的 id 不在此路由渲染(外壳直接 iframe 目标 url),此路由遇到 screen id 返回提示文本
2. `<appDir>/%5F%5Fcs/registry/route.ts` —— `GET` → `RegistryEntry[]`(服务端 import registry,args/env/url 是纯对象可序列化;有 render 无 url → component)
3. `<appDir>/%5F%5Fcs/tokens/page.tsx` —— client 页面:枚举 `document.styleSheets` 里 `:root`/`@theme` 的自定义属性,渲染色板(`--color-*`,`--radius-*`,`--font-*`,`--spacing-*` 等),分组网格展示。production 同样挡掉
4. `<designDir>/__generated__/registry.tsx` —— Agent B 的 watcher 生成:
   ```tsx
   import * as m0 from '../Button.artboard'
   export const modules: Record<string, Record<string, unknown>> = { 'Button.artboard': m0 }
   ```
   相对 import 路径按文件实际位置算。design 目录不存在时生成空 modules。

注入文件里不出现 "loupe" 字样,品牌一律 contactsheet / `__cs`。模板以**字符串**形式放在 Agent B 的 ts 源里(我们的 tsconfig 不编译 JSX)。

## 模块入口签名(stub 已建,不许改签名)

```ts
// src/config.ts (A)
export function loadConfig(cwd: string, flags: Partial<CsConfig>): CsConfig

// src/server/index.ts (A)
export function startServer(cfg: CsConfig): Promise<{ close(): Promise<void> }>

// src/inject/index.ts (B)
export function ensureInjected(cfg: CsConfig): Promise<void>       // 写/更新全部注入文件+gitignore
export function removeInjected(cfg: CsConfig): Promise<void>       // clean 命令用
export function regenerateRegistry(cfg: CsConfig): Promise<RegistryEntry[]>  // 扫描+重写 __generated__/registry.tsx,返回条目(args/env 留 undefined,真值由 Next 端 registry route 给)

// src/watch/index.ts (B)
export function startWatcher(cfg: CsConfig, onChange: (entries: RegistryEntry[]) => void): Promise<{ close(): Promise<void> }>

// src/shot/index.ts (D)
export function screenshot(cfg: CsConfig, req: ShotRequest): Promise<ShotResult>
export function closeBrowser(): Promise<void>

// src/mcp/index.ts (D)
import type { IncomingMessage, ServerResponse } from 'node:http'
export interface McpServices {
  getRegistry(): Promise<RegistryEntry[]>        // A 实现:fetch target 侧 /__cs/registry
  getSelection(): Selection | null
  getAnnotations(): Promise<Annotation[]>
  takeShot(req: ShotRequest): Promise<ShotResult>
}
export function createMcpHandler(services: McpServices): (req: IncomingMessage, res: ServerResponse) => Promise<void>

// src/init/index.ts (E)
export function runInit(cwd: string, flags: Partial<CsConfig>): Promise<void>
```

`src/cli.ts`(A):无依赖参数解析(node:util parseArgs)。命令:
- `contactsheet`(默认)= ensureInjected → startWatcher → startServer,Ctrl-C 优雅退出(close watcher/server/browser)
- `contactsheet init` = runInit(E 实现,A 只转发)
- `contactsheet clean` = removeInjected
- flags:`--port` `--target` `--design-dir`

## 画布(Agent C)行为规格

- vanilla TS,零运行时依赖,esbuild 打成 `/__cs/ui/app.js`(build.mjs 已配好,入口 `src/canvas/app.ts`;`index.html` `style.css` 同目录)。
- 启动:fetch `/__cs/api/state` + `/__cs/registry` → 建墙;连 `/__cs/events` SSE,`registry` 事件 → 增量增删画板,`annotations` 事件 → 重画 pin。
- 布局:按 `kind` 分区(页面在上、组件在下),区内网格铺排 —— 页面 4/行、组件 15/行;区内顺序按文件名字典序 + export 顺序,**位置稳定**。
  - **每块画板都有固化坐标**(`cs-pos:<projectRoot>:<id>`),不只是拖过的那些。因此「有坐标」不再等于「被手动摆过」。
  - **全量自动排列只有两个入口**:该项目本机第一次打开(一个坐标都没有)、用户点「自动排列」。新增画板走 `placeNewBoards()`(只给没坐标的找空地,老的不动);其余一切(拖完、改尺寸、测高、显隐、SSE、HMR)只走 `applyPositions()`,不重排。
  - `applyPositions()` 末尾**必须** `applyView()`:select.ts 的高亮框/标签只在 applyView 的监听里重算,摘掉它框会落后。
  - 双击标题条 = 把这一块放回自动排列会给它的位置(只动它自己)。
  - 尺寸也缓存(`cs-fit:<projectRoot>:<id>`):位置固化后尺寸必须跨会话稳定,否则刷新时画板从初始宽高重新长起来会把排好的墙撞乱。
  - 左侧图层列表负责导航与显隐;分区/文件组可折叠(`cs-collapsed:<projectRoot>`),整组显隐走 `setHidden(ids, hidden)`(落盘与重排各一次)。
- 画板 = 标题条(exportName + kind 徽标)+ iframe。component → `/__cs/ab/<id>`;screen → 目标 `url`(直接走代理)。宽 = `env.width ?? 480`;高 = `env.height ??` 自动:onload 后读 `contentDocument.documentElement.scrollHeight`(夹在 88–1200;`TITLE_H` 必须等于 style.css 的 `--cs-title-h`),之后每次 SSE registry 事件重测一次。
- 注入页的 wrapper `div[data-cs-artboard]` **不留内边距**:有 padding 时组件的盒子会比 body 画的底小一圈(实测 390 宽的板四周各差 16px),高亮框与可见底色永远对不齐。提示页/错误卡不是被审视的组件,单独留 16px。
- `.cs-frame` 不加圆角也不加阴影:带这两样,白底读起来是"又浮了一张卡片",而高亮框是直角矩形,形状对不上;边界只由那条 1px outline 表达。
- 组件底色:iframe 画布恒不透明,所以必然有底。全局开关 `cs-bg-default:<projectRoot>`,两档 —— `blend`(默认,把 iframe 的 `html/body` 刷成运行时读到的 `--cs-bg`,同时 `.cs-frame` 去掉白底/描边/阴影;**两层必须一起去,只去一层白块还在**)、`real`(项目自己的背景)。单板可覆盖,键删除 = 跟随全局。**screen 画板不参与**(不注入、frame 仍白)。
- 懒挂载:IntersectionObserver,视口外 1.5 屏内才挂 iframe,未挂时显示占位(灰底 + 名字)。
- **screen 画板首次出现默认隐藏**(`cs-seen:<root>` 判定"首次";用户显隐选择永远优先,只有没见过的 id 才被默认藏)。**隐藏板绝不挂载**,三道闸:createBoard 出生即 `el.hidden`(IO 首帧回调抢在 applyPositions 前);IO 回调对隐藏板 continue 且**不 unobserve**(打开时 IO 会再报一次 intersecting);requestMount 入口兜底 return。默认藏了东西必须 toast 告知(用户加了 screens 一行,墙上没动静,要说清去了哪)。
- CLI 输出统一走 src/term.ts(零依赖 ANSI):✓ 绿完成 / ⚠ 黄注意 / ✖ 红失败 / 青色链接 / dim 次要;尊重 NO_COLOR 与非 TTY(管道时纯文本)。cli.ts 顶部 `process.noDeprecation = true`(http-proxy 的 DEP0060 用户无法处置)。
- 缩放/平移:世界容器 `transform: translate+scale`。平移=空白处拖拽或双指滚轮;缩放=Ctrl+wheel/捏合,以光标为锚点,范围 0.05–2。
- 三模式:
  - **浏览**(默认,Esc 回来):每块画板上盖 overlay(`pointer-events:auto`),mousemove → `elementFromPoint` 高亮(在外壳层画描边框,不进 iframe 改 DOM);click → 生成 CSS selector(id > data-* > 标签+nth-of-type 链,≤5 层)→ POST `/__cs/api/selection` 并显示选中框。
    **组件画板的反查过滤**(elementAt 源头统一,hover/点选/钉 pin 三条路共用):改用 `elementsFromPoint`,从命中栈顶往下找第一个**画了东西的**元素(底色 α>0 / 边框 / 阴影 / 背景图 / 直接文本节点 / 替换元素与表单控件 / svg);走到 `html`/`body`/`[data-cs-artboard]` wrapper 就停,返回 null。透明的布局容器(grid/flex 根)什么都没画,不配被指着 —— 否则组件小、视口大时,空白处永远先选中一大片看不见的"面板"。computed backgroundColor 可能是 lab()/oklch(),非 rgba 格式一律当不透明。screen 画板不过滤(body 就是页面本身)。
    组件画板 iframe 注入的 `#__cs_bg` 样式同时隐掉根滚动条(`html{scrollbar-width:none}` + `::-webkit-scrollbar`),两档都隐;组件内部滚动区不动 —— 那是它自己的真实样子。
  - **交互**(双击画板进入):该画板 overlay `pointer-events:none`,亮边框,其余画板压暗 40%。
  - **走查**(选中画板后按 Enter):该画板 iframe 全屏铺满,Esc 退出。
- pin 批注:浏览模式按 `c` 后点击元素 → 内联输入框 → POST annotations(带 anchor)。已有 pin 画成小圆点,hover 出气泡(文本+status),气泡里可 resolve(PATCH)。
  气泡里的 refs 显示为「图片 n」占位符 + 缩略图(✕ 移除:展示态立即 PATCH,编辑态暂存到「保存」;移除只解绑不删文件)。
  **行内占位符**:粘贴在光标处插 `[图片 n]`(n=粘贴顺序,refs 下标+1;上传中 refs 占坑 `__uploading__`,保存/提交被挡);✕ 移除时正文 `removeRefToken` 摘掉该编号并把更大的编号全部 -1,与 refs.splice 严格同步。buildContextText 的参考图行是 `  图片 n:<路径>`,与正文编号一一对应。
  **token 是原子的**(bindTokenAtomics,composer 与编辑态两处 textarea 都绑):Backspace/Delete 落在 token 内或边上 = 整个 token+它的图一起删并重编号,绝不留半截;选区碰到 token 时扩到 token 边界整体删。
  **孤儿 pin 必须重试**:SPA 页 load 后才异步渲出内容,锚点首查失败是常态;renderBoardPins 对孤儿板指数退避重试 ≤8 次(~22s),编辑中不重画。不重试的话刷新后 pin 永远钉在左上角(实测)。
  **画布 wheel 监听必须放行 `.cs-pin-bubble`/`.cs-pin-input` 内的滚轮**(view.ts):否则批注编辑框里滚动滚的是整面墙;配套 `overscroll-behavior: contain` + 定制滚动条(RESP-015)、textarea `resize:none`。
  **pin 圆点显示 `Annotation.seq`(项目内永久序号)**:创建时由服务端按全表 max+1 分配(含 verified,核验不释放号);旧数据在 readAnnotations 时按文件顺序确定性补号,随下一次写落盘。buildContextText 的每条批注前缀 `#seq`,与墙上数字一致 —— 禁止退回"本板内 i+1"编号:那会出现多个"1",且前面的批注核验后后面全体变号。
- 贴图:document paste 事件收图片 → POST `/__cs/api/refs`。**按上下文路由**:批注输入框/气泡编辑态用 `setPasteTarget()` 登记自己(元素从 DOM 摘掉即自动失效),此时图挂到那条批注的 `refs`;没有 target 才进右下角的全局坞。气泡编辑态里的图**不立刻 PATCH** —— 立刻 PATCH 会经 SSE 触发 renderPins,把用户正在打的字连输入框一起冲掉;跟文字一起在「保存」时提交。
- args 面板:浏览模式单击画板标题条 → 右侧面板:从 iframe 的 `#__cs_meta` 读 `{args}`,按值类型出控件(boolean→checkbox,number→number input,string→text input,其他→JSON textarea);改动 → 更新 iframe src 的 `?args=`(replace,~100ms server 重渲)。「存为画板」v1 不做,面板上放禁用按钮占位并 tooltip 说明。
- HUD:左下角常驻当前模式 + 快捷键提示;`pointer-events:none`(它盖住的画板必须照样能拖能点)。
- 全局单键快捷键的豁免范围 = `isEditable()`:除 INPUT/TEXTAREA/SELECT/contenteditable 外,**焦点在 `#cs-sidebar` / `#cs-args` / `.cs-picker` / `#cs-topbar` 内也一律豁免** —— 这些容器里的 `<button>` 自己要用 Enter/Space/Backspace,只按标签名判断会让侧栏的按钮永远按不下去。
- 视图动画 `animateTo()` 用 CSS transition:过渡期间 `state` 已是终值、DOM 还在半路,读几何的监听者这一帧算出来全是错的。所以过渡结束后**必须再补一次 `applyView()`**,否则错位会永久钉住(select.ts 另外自己用 `liveScale()` 现量缩放兜底)。
- SSE `registry` 事件比 Next 重编译快约 1 秒,事件到达时 `/__cs/registry` 往往还是旧的那份。`onRegistryEvent` 拿 SSE 报的 id 集合当预期,对不上就 700ms 间隔重拉,最多 4 次。

## 端口策略(cli/server)

- `startServer` 返回 `{ port, close }`,`port` 是**实际**监听端口(可能顺延),banner 必须用它。
- **双栈绑定**:默认 host 下同时绑 `127.0.0.1` 与 `::1`(共享同一 request/upgrade handler 的孪生 server;孪生的连接同样进 socket 追踪表)。一个端口 v4+v6 **都绑上才算空闲**,v6 被占(Docker 端口转发常蹲 IPv6 通配)也走顺延 —— 只绑 v4 会出现"curl 正常、浏览器 502"的半瞎冲突。机器没有 IPv6(EADDRNOTAVAIL/EAFNOSUPPORT)时单栈放行。显式非回环 host 不做孪生。
- 交互模式:单击非激活画板**不切换**(误触不打断),但必须给反馈(probe + toast「双击它切换」,同板 4 秒节流);Backspace 在浏览模式、无选中 pin 时收起当前激活画板(setHidden,非删除,toast 告知去向)。
- 被占时(**0.1.6 起禁止顺延**,实测事故:顺延后升级静默失效、mcp/hook 指向旧进程且无人收到错误):
  先探 `/__cs/api/state`(超时 2.5s、重试 2 轮 —— 旧实例正忙时 800ms 一枪打空会把同项目误判成陌生进程)——
  同 projectRoot 且**版本相同** → 打印地址 `exit(0)`;版本不同 → `exit(1)` 提示 kill 旧实例;
  陌生进程 → 硬失败,报错带占用者 PID(lsof 尽力而为)。
- init 的默认 target 会先认 package.json dev script 里的 `-p/--port/PORT=`(非 3000 才生效)。

## 健康探测与代理卫生

- `startHealthMonitor`(server/health.ts):每 20s(`CS_HEALTH_INTERVAL_MS`)探 `${target}/__cs/registry`(**必须探 SSR 路径**,僵死指纹下静态资源是假阴性),超时 10s(`CS_HEALTH_TIMEOUT_MS`),**连挂 2 次**才广播 `{type:"health"}`(单次抖动/冷编译不拉横幅);**从未成功过不判死刑**(冷启动归错误卡管)。404 算活着(clean 过注入文件)。
- 画布横幅(health-banner.ts):全局一条说清归因,显示绝对时刻不做滴答(COMP-009);**健康快照必须在拉注册表之前取**,SSE 也要先连 —— 僵死期注册表请求会吊死,谁排它后面谁陪葬。fetchRegistry 带 15s 超时,超时走错误卡 3s 重试。
- **代理必须把客户端中断传给上游**(proxyReq + res close 且未 writableEnded → destroy):不传的话每次中断泄一个 fd(实测 300 次泄 300 个,永不回收),且对 dev server 是永远 in-flight 的渲染请求,僵死期的重试洪水会把它压得更死。正常完成的请求不动(别误杀 keep-alive 池)。
- **e2e 端口表**(全部专用,严禁 3000/5199:随时可能被用户的项目占着,waitHttp 会等到别人的 server):e2e.mjs 外壳 5641/dev 5643;e2e-interact 外壳 5642/dev 5644;shot.mjs dev 5645。

## Agent A 补充细节

- 静态资产:优先 `dist/canvas/`(与 cli.js 同发布);若不存在(开发期),回落读 `src/canvas/`,其中 app.js 开发期由 `node build.mjs --watch` 产出到 dist——即回落顺序 dist → src,`index.html`/`style.css` 两处任一。
- `/__cs/registry` 的代理放行同其他;A 自己的 `McpServices.getRegistry` 用 `fetch(target 不经过代理)` + 环境变量代理规避(node fetch 默认不走系统代理,无需处理)。
- SSE:心跳 15s 注释行;客户端断开要清引用。
- annotations 文件读写要原子(写临时文件+rename),文件不存在视为 `[]`;id 用 `a`+递增或短随机。
- watcher 的 onChange → 触发 SSE `registry` 事件(entries 直接透传;args 可能为 undefined,画布端仍以 Next 侧 `/__cs/registry` 为准,SSE 只当"该刷新了"的信号+快速增删依据)。
- 代理错误(Next 没起)→ `/__cs` 外的请求返回 502 简页:"contactsheet:目标 :3000 未启动";画布自身照常可开。

## Agent D 补充细节

- screenshot:playwright-core `chromium.launch({channel:'msedge', headless:true})`,浏览器实例懒启动+复用,60s 无活动自动关(计时器),`closeBrowser()` 供退出钩子。
- 单板:开 `http://localhost:<port>/__cs/ab/<id>?args=...`(component)或 `http://localhost:<port><url>`(screen),viewport 宽=env.width??480,高 900,等 `networkidle`+50ms,截全页。存 `design/.canvas/shots/<id>.png`(目录自动建)。
- 全墙:开 `/__cs`,viewport 2400×1350,等 3s,截视口。
- MCP 四工具(全只读):
  - `canvas_list`:→ getRegistry,返回 JSON 文本
  - `canvas_screenshot`:入参 `{id?: string}`,→ takeShot,返回 image content(base64 png)+ 路径文本
  - `canvas_selection`:→ getSelection,JSON 或 "no selection"
  - `canvas_annotations`:→ getAnnotations 过滤 status=open,JSON
- SDK:`@modelcontextprotocol/sdk` 的 `McpServer` + `StreamableHTTPServerTransport`(无 session 持久化,stateless 模式)。

## Agent E 补充细节

- `runInit`:
  1. 探测 appDir(`app/` 或 `src/app/`),Next 项目校验(package.json 有 next),写 `contactsheet.config.json`(target/port/designDir 默认值)
  2. `.gitignore` 追加注入路径(幂等,带 `# contactsheet` 注释段)
  3. 自动铺画板:扫 `components/ui/*.tsx`,每个文件取导出的首个大写开头组件名,生成 `design/<Name>.artboard.tsx`:`export const 默认 = { render: () => <Name>示例</Name> }`(import 路径用 `@/components/ui/<file>`;已存在的 artboard 不覆盖)。生成数量打印出来。
  4. `.mcp.json` 合并写入 `{"mcpServers":{"contactsheet":{"type":"http","url":"http://localhost:<port>/__cs/mcp"}}}`(已有其他 server 保留)
  5. `.claude/settings.json` 合并写入 UserPromptSubmit hook:`{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"curl -s --noproxy '*' --max-time 1 http://localhost:<port>/__cs/api/context || true"}]}]}}`(幂等:同 command 不重复加)
  6. 结尾打印下一步指引
- README.md:安装、init、日常一条命令、三模式快捷键、artboard 约定、登录态说明(cookie 不分端口,:3000 登过 :5199 直接有;localStorage token 的项目要在 :5199 再登一次)、边界(RSC 无限制、MSW mocks 未实现是 v1.1、走查模式勉强、别当开发环境)。

## 代码风格

- 注释中文,标识符英文。Node 内建 import 一律 `node:` 前缀。不引契约外的新依赖。
- 每个 agent 完成前必须:`pnpm exec tsc --noEmit` 全绿;能自测的部分写一个 `src/<模块>/selftest.mjs`(直接 node 跑,不进 dist)并跑通;报告里写清:做了什么、自测结果、没做/做不了什么。
