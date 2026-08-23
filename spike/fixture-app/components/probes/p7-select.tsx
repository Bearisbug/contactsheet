"use client"

import { useState } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const densities = { compact: "紧凑", cozy: "舒适", spacious: "宽松" }

/** P7 —— Select：popup 走 Portal + Positioner，浮层定位依赖真实 anchor 尺寸 */
export function P7Select() {
  const [value, setValue] = useState<string | null>("cozy")

  return (
    <div data-probe="p7" className="rounded-lg border p-4 flex flex-col gap-2 items-start bg-orange-50">
      <span className="font-mono text-xs">P7 Select（portal 浮层）</span>
      <Select
        items={densities}
        value={value}
        onValueChange={(v) => setValue(v as string | null)}
      >
        <SelectTrigger data-probe="p7-trigger" size="sm" aria-label="密度">
          <SelectValue placeholder="选择密度" />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(densities).map(([v, label]) => (
            <SelectItem key={v} value={v}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="font-mono text-xs opacity-60">
        value → <b data-probe="p7-value">{value ?? "(空)"}</b>
      </span>
    </div>
  )
}
