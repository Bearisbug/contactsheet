import { Suspense } from "react"
import { P1PureClient } from "@/components/probes/p1-pure-client"
import { P2ImageFont } from "@/components/probes/p2-image-font"
import { P3Navigation } from "@/components/probes/p3-navigation"
import { P4ServerAsync } from "@/components/probes/p4-server-async"
import { P5Barrel } from "@/components/probes/p5-barrel"
import { P6Toast } from "@/components/probes/p6-toast"
import { P7Select } from "@/components/probes/p7-select"
import { ViewportProbe } from "@/components/probes/viewport-probe"

export default function DashboardPage() {
  return (
    <main className="p-6 flex flex-col gap-4">
      <h1 className="text-lg font-semibold">fixture /dashboard</h1>
      <ViewportProbe />
      {/* 窄屏走单列、宽屏走两列，给"墙上并排多个宽度"一个可见的布局差异 */}
      <div className="grid grid-cols-2 gap-4 max-[430px]:grid-cols-1">
        <P1PureClient />
        <P1PureClient tone="warn" density="tight" label="P1 warn/tight" />
        <P2ImageFont />
        <Suspense fallback={<div className="rounded-lg border p-4 text-xs">P3 loading…</div>}>
          <P3Navigation />
        </Suspense>
        <P4ServerAsync />
        <P5Barrel />
        <P6Toast />
        <P7Select />
      </div>
    </main>
  )
}
