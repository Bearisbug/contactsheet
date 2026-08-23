// 组件画板样例:args 可拨,四个状态并排
import { Button } from "@/components/ui/button"
import { LoaderCircleIcon } from "lucide-react"
import type { ComponentProps, ReactNode } from "react"

type A = ComponentProps<typeof Button>

function 状态行({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 font-mono text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

export const 默认 = {
  render: (a: A) => <Button {...a}>保存比赛</Button>,
  args: { variant: "default", size: "default", disabled: false },
  env: { width: 390 },
}

export const 危险 = {
  render: (a: A) => (
    <div className="flex flex-col gap-3 items-start">
      <状态行 label="默认">
        <Button {...a}>删除全部</Button>
      </状态行>
      <状态行 label="禁用">
        <Button {...a} disabled>
          删除全部
        </Button>
      </状态行>
      <状态行 label="加载中">
        <Button {...a} disabled>
          <LoaderCircleIcon className="animate-spin" />
          删除中
        </Button>
      </状态行>
      <状态行 label="校验错误">
        <Button {...a} aria-invalid>
          删除全部
        </Button>
      </状态行>
    </div>
  ),
  args: { variant: "destructive", size: "default", disabled: false },
  env: { width: 390 },
}

export const 描边禁用 = {
  render: (a: A) => <Button {...a}>不可用</Button>,
  args: { variant: "outline", disabled: true },
  env: { width: 390 },
}

export const 小号 = {
  render: (a: A) => <Button {...a}>小按钮</Button>,
  args: { variant: "secondary", size: "sm" },
  env: { width: 240 },
}
