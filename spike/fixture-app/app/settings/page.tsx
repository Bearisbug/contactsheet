import Link from "next/link"

export default function SettingsPage() {
  return (
    <main className="p-6 flex flex-col gap-3">
      <h1 data-probe="settings-title" className="text-lg font-semibold">
        fixture /settings
      </h1>
      <p className="text-sm opacity-70">
        跳到这里说明客户端路由真的走了一次导航。
      </p>
      <Link href="/dashboard" className="text-sm underline underline-offset-4">
        ← 回 /dashboard
      </Link>
    </main>
  )
}
