/**
 * 地基探针：iframe 宽 390px 时 @media(max-width:430px) 到底命不命中。
 * 截图上一眼就能读出结论，不需要开 devtools。
 */
export function ViewportProbe() {
  return (
    <div
      data-probe="viewport"
      className="rounded-lg border-2 p-4 font-mono text-sm border-emerald-500 max-[430px]:border-rose-500"
    >
      <span data-probe="viewport-wide" className="max-[430px]:hidden text-emerald-600">
        WIDE — @media(max-width:430px) 未命中
      </span>
      <span
        data-probe="viewport-narrow"
        className="hidden max-[430px]:inline text-rose-600"
      >
        NARROW — @media(max-width:430px) 命中
      </span>
    </div>
  )
}
