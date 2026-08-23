"use client"

import { useState } from "react"
import { Toast } from "@base-ui/react/toast"
import { Button } from "@/components/ui/button"

/** P6 —— Base UI Toast：Provider + Portal（默认挂到 document.body）+ Viewport，浮层脱离画板容器 */
export function P6Toast() {
  return (
    <div data-probe="p6" className="rounded-lg border p-4 flex flex-col gap-2 items-start">
      <span className="font-mono text-xs">P6 Toast（portal 到 body）</span>
      <Toast.Provider>
        <ToastTrigger />
        <Toast.Portal>
          <Toast.Viewport className="fixed right-4 bottom-4 z-50 flex w-72 flex-col gap-2">
            <ToastList />
          </Toast.Viewport>
        </Toast.Portal>
      </Toast.Provider>
    </div>
  )
}

function ToastTrigger() {
  const manager = Toast.useToastManager()
  const [n, setN] = useState(0)

  return (
    <Button
      data-probe="p6-button"
      size="sm"
      onClick={() => {
        setN((v) => v + 1)
        manager.add({ title: `Toast ${n + 1}`, description: "来自 P6 的通知" })
      }}
    >
      弹一个 toast
    </Button>
  )
}

function ToastList() {
  const { toasts } = Toast.useToastManager()

  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      data-probe="p6-toast"
      className="rounded-lg border bg-popover p-3 text-popover-foreground shadow-md transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0"
    >
      <Toast.Content className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Toast.Title className="text-sm font-medium" />
          <Toast.Description className="text-xs text-muted-foreground" />
        </div>
        <Toast.Close className="text-xs underline underline-offset-4 opacity-60">
          关闭
        </Toast.Close>
      </Toast.Content>
    </Toast.Root>
  ))
}
