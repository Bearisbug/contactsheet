// 一键推送:把画布上下文注入绑定的 Claude Code 会话(inbox socket)
//
// 通道说明:Claude Code 的 cross-session messaging 会给每个会话开一个 UDS
// (/tmp/cc-socks/<pid>.sock),协议为换行分隔 JSON,注入格式来自 Claude Code
// 自己的启动日志:{"type":"user","message":{"role":"user","content":"..."}}
// 这是半公开的内部通道(官方文档说它服务于 hooks/Bash),版本升级可能变——
// 失败时前端会回落到"复制到剪贴板"。官方正门是 Channels(MCP),列为后续路径。
//
// 会话发现:~/.claude/sessions/<pid>.json 是 Claude Code 的会话登记处,
// 带 name(会话名)/cwd/status/socket 路径;按 cwd ∈ 项目根 过滤,socket 探活去尸体。
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { CsConfig } from "../types.js"

export interface PushTarget {
  pid: number
  name: string
  status: string
  cwd: string
  socket: string
  updatedAt: number
}

interface SessionRecord {
  pid?: number
  cwd?: string
  name?: string
  status?: string
  kind?: string
  messagingSocketPath?: string
  updatedAt?: number
}

/** 250ms 连接探活(与 Claude Code 自己的探活逻辑一致) */
function isLive(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket()
    const done = (ok: boolean): void => {
      s.destroy()
      resolve(ok)
    }
    s.on("connect", () => done(true))
    s.on("error", () => done(false))
    s.setTimeout(250, () => done(false))
    s.connect({ path: sock })
  })
}

/** 列出候选:登记处里 cwd 在本项目下、socket 活着的交互式会话,最近活跃在前 */
export async function listTargets(cfg: CsConfig): Promise<PushTarget[]> {
  const root = path.resolve(cfg.projectRoot)
  const dir = path.join(os.homedir(), ".claude", "sessions")
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: PushTarget[] = []
  await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (n) => {
        let rec: SessionRecord
        try {
          rec = JSON.parse(await fs.readFile(path.join(dir, n), "utf8")) as SessionRecord
        } catch {
          return
        }
        if (!rec.pid || !rec.cwd || !rec.messagingSocketPath) return
        if (rec.kind && rec.kind !== "interactive") return
        const rel = path.relative(root, path.resolve(rec.cwd))
        if (rel.startsWith("..") || path.isAbsolute(rel)) return // 不在项目内
        if (!(await isLive(rec.messagingSocketPath))) return // 登记处有尸体,探活过滤
        out.push({
          pid: rec.pid,
          name: rec.name ?? `pid ${rec.pid}`,
          status: rec.status ?? "unknown",
          cwd: rec.cwd,
          socket: rec.messagingSocketPath,
          updatedAt: rec.updatedAt ?? 0,
        })
      })
  )
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

/** 写一行 JSONL 进会话 inbox。写成功即视为送达(回执走的是会话间协议,外部进程收不到) */
export function inject(sock: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ path: sock })
    s.setTimeout(3000, () => {
      s.destroy()
      reject(new Error("写入超时"))
    })
    s.on("error", reject)
    s.on("connect", () => {
      const line =
        JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n"
      s.end(line, () => resolve())
    })
  })
}

export type PushResult =
  | { ok: true; pid: number; name: string }
  | { ok: false; reason: string }
  | { ok: false; choose: Array<Pick<PushTarget, "pid" | "name" | "status" | "cwd">> }

/** 推送入口:指定 pid 直发;唯一候选直发;多个候选让前端出选择器 */
export async function pushToSession(
  cfg: CsConfig,
  text: string,
  pid?: number
): Promise<PushResult> {
  const targets = await listTargets(cfg)
  if (!targets.length) {
    return {
      ok: false,
      reason: `没找到工作目录在 ${cfg.projectRoot} 下的 Claude Code 会话(要先在项目目录里开着 claude)`,
    }
  }
  let target: PushTarget | undefined
  if (pid !== undefined) {
    target = targets.find((t) => t.pid === pid)
    if (!target) return { ok: false, reason: `会话 pid ${pid} 已不在(可能刚关掉),重按 p 重选` }
  } else if (targets.length === 1) {
    target = targets[0]
  } else {
    return {
      ok: false,
      choose: targets.map(({ pid: p, name, status, cwd }) => ({ pid: p, name, status, cwd })),
    }
  }
  const body =
    `[contactsheet] 用户在画布上按下了推送键,以下是当前画布上下文,请按批注处理:\n\n` + text
  await inject(target!.socket, body)
  return { ok: true, pid: target!.pid, name: target!.name }
}
