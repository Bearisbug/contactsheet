// ============================================================
// [Agent B] 画板文件 watcher —— 变更 → 重建 registry → 回调
// 签名冻结,见 CONTRACTS.md
// ============================================================
import path from "node:path"
import { watch } from "chokidar"
import type { CsConfig, RegistryEntry } from "../types.js"
import { regenerateRegistry } from "../inject/index.js"

/** 连续变更合并成一次重建 */
const DEBOUNCE_MS = 200

function isArtboard(p: string): boolean {
  return /\.artboard\.tsx?$/.test(p)
}

export async function startWatcher(
  cfg: CsConfig,
  onChange: (entries: RegistryEntry[]) => void
): Promise<{ close(): Promise<void> }> {
  const designAbs = path.join(cfg.projectRoot, cfg.designDir.replace(/\\/g, "/").replace(/\/+$/, ""))
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const flush = () => {
    timer = null
    regenerateRegistry(cfg)
      .then((entries) => {
        if (!closed) onChange(entries)
      })
      .catch((err) => {
        console.error("[contactsheet] 重建 registry 失败:", err)
      })
  }
  const schedule = () => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, DEBOUNCE_MS)
  }

  const watcher = watch(designAbs, {
    ignoreInitial: false, // 首次也算一次变更
    ignored: (p: string) => {
      const rel = path.relative(designAbs, p)
      if (!rel) return false
      // 生成物与画布数据不参与监听
      return rel.split(path.sep).some((seg) => seg === "__generated__" || seg === ".canvas" || seg === "node_modules")
    },
  })
  watcher.on("add", (p) => isArtboard(p) && schedule())
  watcher.on("change", (p) => isArtboard(p) && schedule())
  watcher.on("unlink", (p) => isArtboard(p) && schedule())
  watcher.on("error", (err) => console.error("[contactsheet] watcher 出错:", err))

  // design 目录为空或不存在时也要给一次初始回调
  schedule()

  return {
    async close() {
      closed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      await watcher.close()
    },
  }
}
