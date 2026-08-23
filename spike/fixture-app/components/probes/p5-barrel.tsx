import { cn, readPackageName } from "@/lib"

/**
 * P5 —— 同步 server component（不是 async、不是 client）。
 * 从桶文件 @/lib 里只拿 cn，但桶后面挂着 server-only + node:fs。
 * Next 渲染它毫无压力；它失败只可能因为模块图被毒死，和 async 无关。
 */
export function P5Barrel() {
  const pkg = readPackageName()

  return (
    <div data-probe="p5" className={cn("rounded-lg border p-4 flex flex-col gap-1 items-start")}>
      <span className="font-mono text-xs">P5 桶导入（server-only + node:fs）</span>
      <span className="font-mono text-xs opacity-60">package.json name → {pkg}</span>
    </div>
  )
}
