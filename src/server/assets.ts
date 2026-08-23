// 画布静态资产定位。打包后 cli.js 在 dist/,资产在 dist/canvas/;
// 开发期(app.js 由 build.mjs --watch 产出到 dist)回落包根的 dist/canvas 与 src/canvas
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, "..")

const DIRS = [
  path.join(here, "canvas"), // 发布形态:dist/cli.js 旁边的 dist/canvas
  path.join(pkgRoot, "dist", "canvas"),
  path.join(pkgRoot, "src", "canvas"), // 开发期直读源码里的 index.html / style.css
]

/** 逐个候选目录找资产文件,找不到返回 null */
export function findUiFile(name: string): string | null {
  for (const dir of DIRS) {
    const p = path.join(dir, name)
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
  }
  return null
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

export function mimeOf(file: string): string {
  return MIME[path.extname(file)] ?? "application/octet-stream"
}

/** StateInfo.version 用;读不到就给个占位。
 *  必须在进程启动时定格:每次现读的话,旧进程会报出磁盘上的**新**版本号,
 *  端口被占时的版本比对在"升级"这个最需要它的场景恰好失明(实测) */
const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")) as { version?: string }
    return pkg.version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
})()

export function pkgVersion(): string {
  return VERSION
}
