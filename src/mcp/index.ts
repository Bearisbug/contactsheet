// [Agent D] MCP 端点 —— 挂在外壳的 /__cs/mcp,给 Claude Code 提供四个只读工具
// stateless 模式:每个 POST 现建一套 McpServer + StreamableHTTPServerTransport,响应完即销毁
import type { IncomingMessage, ServerResponse } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"
import type { Annotation, RegistryEntry, Selection, ShotRequest, ShotResult } from "../types.js"

export interface McpServices {
  getRegistry(): Promise<RegistryEntry[]>
  getSelection(): Selection | null
  getAnnotations(): Promise<Annotation[]>
  takeShot(req: ShotRequest): Promise<ShotResult>
}

/** 工具返回值:只用到 text / image 两种 content */
type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]
  isError?: boolean
}

/** 工具执行抛错不能崩 handler:统一转成 isError 文本 */
async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // shot 模块的错误信息自带 "contactsheet: " 前缀,别叠两层
    const text = msg.startsWith("contactsheet:") ? msg : `contactsheet: ${msg}`
    return { isError: true, content: [{ type: "text", text }] }
  }
}

function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] }
}

/** 每个请求现建一台 server(stateless 模式下 server 与 transport 都不能跨请求复用) */
function buildServer(services: McpServices): McpServer {
  const server = new McpServer(
    { name: "contactsheet", version: "0.1.0" },
    { capabilities: { tools: {} } }
  )

  server.registerTool(
    "canvas_list",
    {
      title: "列出画板",
      description:
        "列出 contactsheet 画布上的全部画板(设计稿)。返回 JSON 数组,每项含 id、file(源文件相对路径)、exportName、kind(component=组件画板 / screen=页面画板)、args(组件默认入参)、env(宽高等)。要截某块画板前先用它拿到准确的 id。",
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => text(await services.getRegistry()))
  )

  server.registerTool(
    "canvas_screenshot",
    {
      title: "截图画板",
      description:
        "给画板截图并把图片返回给你看。传 id 截单块画板(id 从 canvas_list 拿,组件画板截全页);不传 id 截整面画布墙的概览。返回一张 PNG 图片 + 图片在 repo 里的保存路径。想确认 UI 改动的实际效果就用它。",
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe("画板 id(来自 canvas_list);省略则截整面墙的概览图"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) =>
      guard(async () => {
        const shot = await services.takeShot(id ? { id } : {})
        return {
          content: [
            { type: "image", data: shot.base64, mimeType: "image/png" },
            { type: "text", text: `已保存:${shot.path}(${shot.width}×${shot.height})` },
          ],
        }
      })
  )

  server.registerTool(
    "canvas_selection",
    {
      title: "当前选中元素",
      description:
        "读用户此刻在 contactsheet 画布上点选的元素:返回 JSON,含 artboardId(哪块画板)、selector(画板文档内的 CSS 选择器)、x/y(元素内 0-1 相对坐标)、ts(时间戳)。用户说「这个按钮」「这里」的时候先调它确认指的是谁。没有选中时返回 no selection。",
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const selection = services.getSelection()
        return selection ? text(selection) : text("no selection")
      })
  )

  server.registerTool(
    "canvas_annotations",
    {
      title: "未处理批注",
      description:
        "列出画布上状态为 open(未处理)的批注:返回 JSON 数组,每项含 id、text(用户写的话)、artboardId、anchor(锚定的元素与位置)、refs(附带的参考图路径)、createdAt。这些就是用户希望你改的地方。",
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const all = await services.getAnnotations()
        return text(all.filter(a => a.status === "open"))
      })
  )

  return server
}

/** JSON-RPC 形式的错误响应(GET/DELETE 不支持,以及内部异常) */
function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }))
}

export function createMcpHandler(
  services: McpServices
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 无 session 持久化 → 没有 GET 通知流,也没有 DELETE 终止 session
    if (req.method !== "POST") {
      sendJsonRpcError(res, 405, -32000, "Method not allowed.")
      return
    }

    const server = buildServer(services)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    // 响应结束/客户端断开都要拆掉这套一次性实例
    res.on("close", () => {
      void transport.close().catch(() => {})
      void server.close().catch(() => {})
    })

    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      sendJsonRpcError(res, 500, -32603, `Internal server error: ${msg}`)
    }
  }
}
