"use client"

import { useState } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

const panel = cva("rounded-lg border p-4 flex flex-col gap-3 items-start", {
  variants: {
    tone: {
      neutral: "bg-card text-card-foreground",
      warn: "bg-green-50 border-green-400 text-green-950",
    },
    density: { cozy: "gap-3", tight: "gap-1" },
  },
  defaultVariants: { tone: "neutral", density: "cozy" },
})

type P1Props = VariantProps<typeof panel> & { label?: string }

/** P1 —— 纯 client：cva variants + cn(clsx+tailwind-merge) + useState + @/ alias */
export function P1PureClient({ tone, density, label = "P1 纯 client" }: P1Props) {
  const [n, setN] = useState(0)

  return (
    <div data-probe="p1" className={cn(panel({ tone, density }), "w-full")}>
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{label}</Badge>
        <span className="font-mono text-xs opacity-60">tone={tone ?? "neutral"}</span>
      </div>
      <Button data-probe="p1-button" size="sm" onClick={() => setN((v) => v + 1)}>
        clicked {n}
      </Button>
    </div>
  )
}
