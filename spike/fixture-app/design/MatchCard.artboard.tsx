// 服务端能力画板:P4(async server component)与 P5(server-only 桶)直接上墙
import { P4ServerAsync } from "@/components/probes/p4-server-async"
import { P5Barrel } from "@/components/probes/p5-barrel"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export const 比分卡_异步服务端 = {
  render: () => <P4ServerAsync />,
  env: { width: 390 },
}

export const 服务端桶导入 = {
  render: () => <P5Barrel />,
  env: { width: 390 },
}

export const 空态 = {
  render: (a: { count: number; message: string }) => (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          今日比赛 <Badge variant="secondary">{a.count}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs opacity-60">{a.message}</p>
      </CardContent>
    </Card>
  ),
  args: { count: 0, message: "还没有比赛,去创建一场吧" },
  env: { width: 390 },
}
