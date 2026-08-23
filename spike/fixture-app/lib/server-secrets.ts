import "server-only"
import fs from "node:fs"
import path from "node:path"

// 只在服务端可用：node 内建 + server-only 双重毒性，用来测桶文件是否毒死浏览器打包器
export function readPackageName(): string {
  const raw = fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")
  return JSON.parse(raw).name as string
}
