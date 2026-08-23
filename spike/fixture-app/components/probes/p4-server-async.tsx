import { getMatches } from "@/lib/data"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/** P4 —— async server component。模块图干净，唯一变量就是"函数本身是 async 的" */
export async function P4ServerAsync() {
  const matches = await getMatches()

  return (
    <Card data-probe="p4" className="w-full">
      <CardHeader>
        <CardTitle className="text-sm">P4 async server component</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {matches.map((m) => (
          <span key={m.id} className="font-mono text-xs">
            {m.home} {m.score} {m.away}
          </span>
        ))}
      </CardContent>
    </Card>
  )
}
