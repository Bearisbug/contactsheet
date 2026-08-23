import Image from "next/image"
import { Geist_Mono } from "next/font/google"
import probePng from "@/public/probe.png"

const mono = Geist_Mono({ subsets: ["latin"], weight: "400" })

/** P2 —— next/image（静态导入 StaticImageData + 字符串 src）+ next/font/google + @/ alias 指向 public */
export function P2ImageFont() {
  return (
    <div data-probe="p2" className="rounded-lg border p-4 flex flex-col gap-3 items-start bg-yellow-50">
      <span className={`${mono.className} text-xs`}>
        P2 next/font/google — 这行是 Geist Mono
      </span>
      <div className="flex items-center gap-4">
        <Image
          data-probe="p2-static"
          src={probePng}
          alt="static import"
          width={48}
          height={48}
          className="rounded"
        />
        <Image
          data-probe="p2-string"
          src="/probe.png"
          alt="string src"
          width={48}
          height={48}
          className="rounded"
        />
      </div>
      <span className="font-mono text-[10px] opacity-60">
        static: {probePng.width}×{probePng.height} @ {probePng.src.slice(0, 28)}…
      </span>
    </div>
  )
}
