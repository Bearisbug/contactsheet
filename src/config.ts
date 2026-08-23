// 配置加载:<cwd>/contactsheet.config.json + CLI flags 合并,缺省值兜底
import fs from "node:fs"
import path from "node:path"
import type { CsConfig } from "./types.js"

const DEFAULT_TARGET = "http://localhost:3000"
const DEFAULT_PORT = 5199
const DEFAULT_DESIGN_DIR = "design"

export function loadConfig(cwd: string, flags: Partial<CsConfig>): CsConfig {
  const projectRoot = path.resolve(cwd)
  const file = path.join(projectRoot, "contactsheet.config.json")

  // 配置文件可以不存在;存在但内容坏了要显式报错,别静默退回默认值
  let fromFile: Partial<CsConfig> = {}
  if (fs.existsSync(file)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CsConfig>
    } catch (err) {
      throw new Error(`contactsheet.config.json 解析失败:${(err as Error).message}`)
    }
  }

  // 优先级:CLI flags > 配置文件 > 默认值
  const pick = <K extends keyof CsConfig>(key: K): CsConfig[K] | undefined => flags[key] ?? fromFile[key]

  const port = Number(pick("port") ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`端口不合法:${String(pick("port"))}`)

  return {
    projectRoot,
    // 末尾斜杠去掉,后面一律靠 `${target}/xxx` 拼
    target: String(pick("target") ?? DEFAULT_TARGET).replace(/\/+$/, ""),
    port,
    portExplicit: flags.port !== undefined,
    appDir: pick("appDir") ?? detectAppDir(projectRoot),
    designDir: pick("designDir") ?? DEFAULT_DESIGN_DIR,
  }
}

/** app 目录探测:存在 src/app 用 src/app,否则 app */
function detectAppDir(projectRoot: string): string {
  return fs.existsSync(path.join(projectRoot, "src", "app")) ? "src/app" : "app"
}
