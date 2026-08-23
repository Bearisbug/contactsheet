"use client"

import Link from "next/link"
import { usePathname, useSearchParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"

/** P3 —— next/navigation 的三个 hook + next/link，Vite 路线必须整套造假 */
export function P3Navigation() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const router = useRouter()

  return (
    <div data-probe="p3" className="rounded-lg border p-4 flex flex-col gap-2 items-start">
      <span className="font-mono text-xs">
        usePathname() → <b data-probe="p3-pathname">{pathname}</b>
      </span>
      <span className="font-mono text-xs">
        useSearchParams() → <b>{searchParams.toString() || "(空)"}</b>
      </span>
      <div className="flex gap-2">
        <Link
          data-probe="p3-link"
          href="/settings"
          className="text-xs underline underline-offset-4"
        >
          &lt;Link href=&quot;/settings&quot;&gt;
        </Link>
        <Button size="sm" variant="outline" onClick={() => router.push("/settings")}>
          router.push()
        </Button>
      </div>
    </div>
  )
}
