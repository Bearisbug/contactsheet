<p align="center"><img src="assets/logo.png" width="320" alt="contactsheet" /></p>

# contactsheet

把你 UI 的各种状态摊在一面可缩放的墙上 —— 一个附着在你自己 Next.js repo 上的联络表。

```
看见 → 指着 → 说话 → 改 → 立刻看见
```

`npx contactsheet` 在 `:5199` 起一层外壳，反代你正在跑的 `next dev`，往你的 app 目录注入一条画板路由，
把 `design/**/*.artboard.tsx` 里的每个 export 摊成一块画板。渲染的还是你自己的 next dev，
所以 Tailwind、字体、provider、RSC、HMR 全都是真的。

画布是**视图不是文档**：一切状态都在 repo 的文件里（画板是 .tsx，批注是 JSON，参考图是 png），
画布随时可以推倒重建，删了也不丢东西。

## 环境要求

- Node >= 20
- Next.js **App Router** 项目（`app/` 或 `src/app/`；Pages Router 用不了）
- 想用截图功能的话本机要装 Microsoft Edge（截图走 playwright-core 的 msedge channel）

## 安装与初始化

在你的 Next.js 项目根目录：

```bash
npx contactsheet init
```

它做四件事，都是合并写入，不会覆盖你已有的配置：

1. 写 `contactsheet.config.json`（`target` / `port` / `appDir` / `designDir`），已存在就保留你改过的值；
2. 扫 `components/ui/*.tsx`（或 `src/components/ui/*.tsx`），给每个组件铺一块骨架画板到 `design/`，
   同名画板已存在就跳过 —— 生成出来的是草稿，本来就该改；
3. `.mcp.json` 里加一个 `contactsheet` MCP server（其他 server 原样保留）；
4. `.claude/settings.json` 里加一条 `UserPromptSubmit` hook（你已有的 hook 原样保留，重复跑不会加第二条）。

任何一个 JSON 文件如果坏掉（不是合法 JSON），init 会直接中止并告诉你是哪个文件，不会重写它。

## 日常

```bash
# 终端 1：照常起你自己的 dev server
pnpm dev

# 终端 2
npx contactsheet
```

然后打开 <http://localhost:5199/__cs>。

flags：`--port`（外壳端口，默认 5199）、`--target`（你的 dev server，默认 `http://localhost:3000`）、
`--design-dir`（画板目录，默认 `design`）。命令也可以简写成 `csheet`。

**端口被占了怎么办**（都不用你手动排查）：

- `init` 会读你 package.json 的 dev script——`next dev -p 3100` 这种写法会被认出来，target 自动写成 3100；
- 5199 被**别的进程**占着：**硬失败**，报错里带占用者 PID 和两条出路（kill 它，或改 config.port 重跑 init）。
  不自动顺延——`.mcp.json`/hook/config 全指着这个端口，静默换端口的话浏览器里看着一切正常，
  agent 侧接线却全指向别的进程，谁都收不到错误（实测这样吞掉过一次升级）；
- 5199 上跑的是**本项目的另一个 contactsheet**：版本相同 → 提示地址直接退出，不起第二个；
  **版本不同 → 报错退出**，提示先 kill 旧实例——静默复用旧的等于升级没生效；
- **判定「被占」看的是双栈**：外壳同时绑 `127.0.0.1` 和 `::1`（浏览器解析 localhost 普遍优先 IPv6——
  只绑 v4 的话，v6 侧被别的进程占着时 curl 一切正常、浏览器却拿到别人的空响应，Docker 的端口转发就常年蹲在
  IPv6 通配上）。任何一侧绑不上都算冲突，照常顺延。

**只监听 127.0.0.1。** 画布没有登录，而 `p` 推送能以你的名义往 Claude Code 会话里说话 ——
所以默认只有本机能连。非 GET 请求还会校验 Origin，推送另外要一枚每次启动随机生成的 token
（只发给画布页，你 app 里的第三方脚本拿不到）。真要局域网访问，改 config 里的 `host`，
启动时会红字警告。

运行时会往你的 app 目录写几个 `__cs` 开头的注入文件，并自动加进 `.gitignore`，不会进你的提交。
它们在 `NODE_ENV=production` 下直接 404，生产构建里没有这层东西。

## artboard 文件约定

扫描范围是 `<designDir>/**/*.artboard.{tsx,ts}`（`__generated__` 除外）。文件里的每个 `export const` 就是一块画板。

**组件画板**（`.tsx`，有 `render`）：

```tsx
// design/Button.artboard.tsx
import { Button } from '@/components/ui/button'

export const 默认 = {
  render: (args: any) => <Button {...args}>保存</Button>,
  args: { variant: 'default', disabled: false },  // 可选，会出现在 args 面板里
  env: { width: 390 },                            // 可选
}

export const 危险 = {
  render: () => <Button variant="destructive">删除</Button>,
}
```

**页面画板**（`.ts`，有 `url`）：直接把你项目里的某个路由挂上墙。

```ts
// design/screens.artboard.ts
export const 仪表盘 = { url: '/dashboard', env: { width: 1440 } }
export const 登录 = { url: '/login', env: { width: 390 } }
```

字段：

| 字段 | 说明 |
|---|---|
| `render(args)` | 组件画板。返回 JSX；`args` 是默认 args 与面板改动浅合并后的结果 |
| `url` | 页面画板。你项目里的路径，走代理直接渲染真页面 |
| `args` | 组件画板的默认入参，能在右侧面板里现场改 |
| `env.width` | 画板宽度 px，默认 480。设 390 就是真的 390 —— `@media (max-width: 430px)` 会命中 |
| `env.height` | 固定高度；不写就按内容自动测（夹在 88–1200 之间） |
| `env.theme` | `light` / `dark` |

export 名可以用中文。布局见下面「左侧列表与布局」一节。

## 三个模式

| 操作 | 进入 | 干什么 |
|---|---|---|
| **浏览**（默认） | `Esc` 随时回来 | 鼠标划过高亮元素，点一下 = 指着它（生成 CSS selector 发给外壳）。组件画板上 `html`/`body`/注入的 wrapper 不参与反查——组件比画板视口小时，空白处什么都不高亮，**指着空白 = 没指任何东西**（页面画板不过滤，body 就是页面本身） |
| **交互** | 双击画板 | 这块画板可以点、可以填、可以展开菜单，其余压暗。压暗的画板点不动是**故意的**（误触不打断你正在交互的板）——点了会提示，**双击那块**即可切换交互目标 |
| **走查** | 选中画板后 `Enter` | 这块画板放大居中（最多 2 倍——不改画板声明的宽度，媒体查询保持真实），`Esc` 退出 |

其他键：

- `c` → 批注模式，点一个元素写一句话，落成一个 pin（存 `design/.canvas/annotations.json`）
- `p`（或顶栏「推送」）→ **一键把 open 批注 + 选中直接注入本项目正在运行的 Claude Code 会话**，不用切窗口。
  绑定全自动：目标 = 工作目录在本项目下的活会话。**同目录开了多个窗口时弹选择器**（显示各会话的
  名字和 idle/busy 状态，数字键或点击选择）。**不记忆上次选过谁** —— 「上次发给哪个窗口」和「这次
  该发给哪个窗口」没有关系，记住它只会让人把话说给错的窗口。只有一个候选时不弹，直发。
  没找到会话时自动回落为复制到剪贴板。
  ⚠️ 通道说明：走的是 Claude Code cross-session messaging 的 inbox socket（`/tmp/cc-socks/`），
  官方文档将其定位为内部机制，版本升级可能失效——失效也只是退回 `y` 复制，不丢功能。
  官方正门是 Channels（MCP `claude/channel`，research preview），列为后续迁移路径。
- `y`（或顶栏「复制批注」）→ 把所有 open 批注 + 当前选中打包进剪贴板，粘给任何 Claude Code 窗口

**批注生命周期**（hover pin 的气泡里操作）：

```
open(橙) ──标记完成──▶ resolved(绿·待核验) ──核验通过──▶ verified(从墙上消失)
              Claude 或你          │  打回                只有人能核验
                                   ▼
                                 open
```

- Claude Code 改完代码后把批注标成 resolved（PATCH `/__cs/api/annotations/:id` 或直接改 JSON 文件），
  **但它到不了 verified —— 核验永远是人的动作**。
- verified 的批注不删除，永久留在 `annotations.json`（带 `resolvedAt`/`verifiedAt` 时间戳）——
  这份文件就是历史记录，日后沉淀 skill / 复盘"当初都提过什么、怎么改的"的原料。
- 「删除」只留给误钉的 pin，会真的从历史里抹掉。
- `Cmd/Ctrl + V` → 贴图，存进 `design/.canvas/refs/`。**在批注输入框或气泡编辑态里粘贴 = 挂到这条批注**
  （缩略图跟着 pin 走，推给 Claude 的上下文里带上它的路径）；在别处粘贴才进右下角的全局坞。
  气泡里的图显示为「图片 n」占位符 + 缩略图，点开大图；**悬停缩略图出 ✕ 可从批注移除**（文件保留在 refs/）
- `Ctrl + 滚轮` / 捏合 → 以光标为锚点缩放（0.05–2 倍）；空白处拖拽或双指滚动 → 平移
- `1` 全景（一屏看完整面墙）· `2` 聚焦当前画板 · `0` 回到 100% · `+` / `-` 步进缩放
- 点一个 pin 选中它，然后 `Enter` 编辑（编辑中再按 `Enter` 保存，`Shift+Enter` 换行）、
  `Backspace` 删除、`Esc` 取消选中
- 浏览模式下没选 pin 时，对着画板按 `Backspace` = **收起这块画板**（不是删除，左侧列表随时点回来）
- **pin 上的数字是批注的永久序号**：按创建顺序分配，全墙唯一，核验/打回都不改号——
  推送给 Claude 的文本里每条批注也带同一个 `#序号`，所以你说「批注 3」，
  你、墙、Claude 指的是同一条。（唯一例外：「删除」误钉的 pin 后，最大号可能被下一条重用）

## 左侧列表与布局

左侧是图层列表：**上半是页面**（显示各自的真实路由，点一下聚焦过去），**下半是组件**（按文件分组）。

**页面画板默认全部收起**，从列表按需打开。一块页面画板 = 一个完整 app 实例的 iframe
（React、provider、realtime 全套），二十几块同时挂载会把 dev server 和浏览器一起拖垮。
收起的画板完全不发请求，打开那一刻才挂载；你开过/关过谁会被记住，新出现的页面画板才默认收起。
组件画板轻得多，默认全部显示。
顶部搜索框按名字/文件/路由过滤；每行右边的圆点是显隐开关——隐藏只是从墙上撤下，随时点回来。
分区标题（「页面」「组件」）和每个文件组都能**折叠**；标题行右侧的三态圆点是**整组一键显隐**
（`●` 全显示 / `◐` 部分 / `◌` 全隐藏，点一下在「全显示」和「全隐藏」之间切）。折叠状态按项目记住。
顶栏 `☰` 收起整个侧栏。

**自动排列只在三个时机发生**：这个项目在本机第一次打开、出现了新画板（只给新的找空地，老的不动）、
你点右上角的「自动排列」。其余情况——拖完、改尺寸、内容变高、HMR、显隐——一律不重排，
所以你摆好的墙不会被冲掉。排列按类型分区，**页面一行最多 4 块，组件一行最多 15 块**。

拖画板的**标题条**挪位置，**每块画板的坐标都按项目存在本机**，刷新和重启都还在原处；
**双击标题条**把这一块放回自动排列会给它的位置（只动它自己）。拖右缘/下缘/右下角改尺寸，双击手柄还原。

## 组件底色

iframe 的画布永远是不透明的，所以组件画板必然有一层底。右上角「组件底色」是全局开关：

- **融入画布**（默认）—— 把 iframe 的 `html/body` 刷成画布同色，组件看起来像直接浮在墙上；
- **项目底色** —— 保留你项目自己的背景（通常是白），看的是组件在真实页面里的样子。

单块画板的标题条上有 `◻`/`▣` 可以单独覆盖全局设置（半透明 = 跟随全局）。
**页面画板不参与** —— 它就是一整个真实页面，底色是它自己的事。

组件画板**不额外留内边距**：组件贴着画板边缘放。这样「你看到的底」和「反查时高亮的盒子」
是同一个矩形；一旦中间垫一层内边距，高亮框就永远比可见的底小一圈，怎么看都对不齐。
需要呼吸感请写进组件自己或 artboard 的 `render`。

## args 面板

浏览模式下单击画板标题条，右侧展开面板：`args` 里的每个字段按类型出控件（布尔 → 勾选框，数字 → 数字框，
字符串 → 文本框，其他 → JSON 文本域）。改动直接改 iframe 的 `?args=`，约 100ms 后服务端重渲。

面板上那个「存为画板」按钮 v1 是禁用的 —— 想把当前这组参数固化下来，请自己往 artboard 文件里再写一个 export。

## tokens 页

<http://localhost:5199/__cs/tokens> 列出你项目 CSS 里 `:root` / `@theme` 下的自定义属性（`--color-*`、`--radius-*`、
`--font-*`、`--spacing-*` 等），分组画成色板。它读的是真实生效的样式表，不是某个配置文件的推测。

## 和 Claude Code 一起用

`init` 已经把两头都接好了：

**MCP 工具**（四个，全都只读）：

| 工具 | 给出什么 |
|---|---|
| `canvas_list` | 当前墙上所有画板（id / 文件 / 类型 / args / env） |
| `canvas_screenshot` | 某块画板的 png（不传 id 就是整面墙） |
| `canvas_selection` | 你此刻指着的元素（画板 id + selector + 相对坐标） |
| `canvas_annotations` | 所有 open 状态的批注 |

**UserPromptSubmit hook**：你每次说话，会自动把「未解决的批注 + 你此刻选中的元素」附在提示词前面。
所以你可以指着屏幕上一个按钮，然后只说「这个圆角太大了」。（contactsheet 没在跑的时候，hook 一秒超时后静默跳过。）

**一切修改走文件。** 这些工具不写任何东西 —— Claude 改的是你的组件源码和 artboard 文件，
改完 HMR 穿过代理推回画布，你立刻看见。画布本身没有「保存」这个动作。

## 登录态

- **cookie 不分端口**。`localhost:3000` 上登过的账号，`localhost:5199` 直接就是登录态，什么都不用做。
- **token 存在 localStorage / sessionStorage 里的项目要多登一次**：storage 按源隔离，`:5199` 是另一个源。
  在 `:5199` 下把你的登录流程走一遍（页面画板正好可以直接开 `/login`），之后就一直有了。

## 接入方式：已有项目 / 新项目

**已有项目**（先把看得见的上墙，再逐步补数据）：

1. `npx contactsheet init` —— 组件骨架画板自动铺出来；
2. 公开页面（登录页、文档页）直接写进 `design/screens.artboard.ts`，立即可看；
3. 受登录保护的页面：在 dev server 的端口登一次测试账号即可（cookie 不分端口，画布共享登录态）；
4. 有**服务端权限守卫**的页面（管理后台这类）：mock 救不了它——守卫跑在服务端，
   唯一正解是给测试账号相应权限（dev seed 提权）。这是项目侧的一次性工作；
5. 带参数的路由（`/t/[teamId]`、`/projects/[id]`）：让项目提供一组**重置后不变的 demo id**
   （固定 slug 的种子数据），画板 url 里直接写死。

页面多了按区拆文件：`screens-public.artboard.ts` / `screens-admin.artboard.ts` / `screens-team.artboard.ts`，
侧栏会按文件分组。`design/` 整个提交进 git——画板即文档，团队共享。

**新项目**（design-first，从第一天就把回路建起来）：

1. 写组件前先写 artboard —— 画板就是组件的规格（要哪些状态，一个 export 一个）；
2. 每建一条路由，顺手在 screens 文件里加一行，路由和画板同步生长；
3. seed 脚本第一天就准备**两个账号**：一个永远空（审空态），一个数据丰富（审满态）——
   这比任何 mock 层都便宜，而且看到的就是真实渲染路径。

**为什么没有 mock 模式**：页面画板渲染的是你 dev server 的真实输出。服务端组件在服务端取数、
守卫在服务端判权，浏览器侧的 mock 层拦不到它们；拦到了，你看的也不再是用户会看到的东西。
数据问题在数据侧解决（种子、测试账号、demo id），画布只负责让你同时看见。

## 边界（先说清楚，省得你试）

- **没有 mock 层，也不打算做**（理由见上一节）。组件的「空态 / 错误态 / 加载中」在组件层传 props 摆出来；
  页面的空态/满态用两个种子账号解决。
- **走查模式很勉强**。它就是把一块画板放大居中，方便盯细节；要走完整流程（多页跳转、真实滚动、devtools），
  请照常开浏览器访问 `:3000`。
- **它不是开发环境，是一扇窗**。构建、测试、调试照旧在你原来的地方做。contactsheet 只负责「同时看见很多状态」
  和「指着其中一个说话」这两件事，别的都不管。
- **Next 的开发指示器会出现在画板角落**。那是你 next.config 的事（`devIndicators: false`），contactsheet 不动你的配置。
- export 名的提取用的是正则，`export const` 之外的花式写法（比如先声明再 `export {}` 重命名）可能认不出来。
- 画板路由在生产环境不可访问：`next build` 的路由清单里它仍然在，但运行时一律 404（`notFound()` 守卫）。
  想连清单都不进，`next build` 前跑一次 `contactsheet clean`。

## dev server 出问题时（画布会替你归因）

画布长开时，被代理的 `next dev` 自己可能出问题。外壳每 20 秒探测一次它的 SSR 路径，
连挂两次就在画布顶部拉**红色横幅**——看到横幅，坏的是 dev server，不是画布。两种实测指纹：

1. **所有路由秒回 500、连请求日志都不打**：`.next` 开发缓存被硬杀打坏（next/font 会进入
   失败重试死循环，`.next` 疯狂膨胀）。重启救不回来，`rm -rf .next` 后再起即愈。
2. **静态资源 200、SSR 报错、API 挂死、worker 数暴涨**：dev server 僵死，重启 `next dev` 即愈。

外壳侧的配合：客户端中途放弃的请求（僵死期浏览器的重试洪水就是这样）会**向上游同步中断**——
否则每次放弃都在 dev server 里留一个永远"渲染中"的挂起请求，把它压得更死（这同时也是外壳自身的
fd 泄漏源，实测 300 次中断泄 300 个 fd，已修）。

## 卸载

```bash
npx contactsheet clean     # 删掉注入进 app 目录的文件
rm contactsheet.config.json
```

`clean` 只清它自己注入的东西。这些是你的，它不会碰，要删自己删：

- `design/`（画板、批注、参考图、截图都在这）
- `.mcp.json` 里的 `contactsheet` 条目
- `.claude/settings.json` 里那条 `UserPromptSubmit` hook
- `.gitignore` 里的 `# contactsheet` 段
