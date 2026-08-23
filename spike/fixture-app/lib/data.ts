// 纯异步数据源：不碰任何 node 内建，确保 P4 只暴露"async server component"这一个变量
export type Match = { id: string; home: string; away: string; score: string }

export async function getMatches(): Promise<Match[]> {
  await new Promise((r) => setTimeout(r, 5))
  return [
    { id: "m1", home: "Arsenal", away: "Chelsea", score: "2–1" },
    { id: "m2", home: "Leeds", away: "Everton", score: "0–0" },
  ]
}
