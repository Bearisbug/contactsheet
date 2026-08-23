// [Agent E] init 自测 —— 在临时目录造假 Next 项目,跑 runInit,断言合并结果 + 幂等
// 跑法:node src/init/selftest.mjs(依赖 node 的 TS type-stripping 直接 import index.ts)

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { runInit } from "./index.ts"

const temps = []
let failed = 0

function assert(cond, msg) {
  if (cond) {
    console.log(`  ok  ${msg}`)
  } else {
    failed++
    console.log(`  FAIL ${msg}`)
  }
}

function eq(actual, expected, msg) {
  assert(actual === expected, `${msg}${actual === expected ? "" : ` —— 期望 ${JSON.stringify(expected)},实际 ${JSON.stringify(actual)}`}`)
}

function mkTemp() {
  const dir = mkdtempSync(join(tmpdir(), "cs-init-selftest-"))
  temps.push(dir)
  return dir
}

function write(root, rel, content) {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, "utf8")
}

function readJson(root, rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"))
}

/** 目录快照:相对路径 → 内容,用来验幂等 */
function snapshot(root, dir = root, out = {}) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) snapshot(root, full, out)
    else out[relative(root, full)] = readFileSync(full, "utf8")
  }
  return out
}

/** 跑 runInit 并把它打印的东西收集起来 */
async function capture(fn) {
  const lines = []
  const orig = console.log
  console.log = (...args) => lines.push(args.join(" "))
  try {
    await fn()
  } finally {
    console.log = orig
  }
  return lines.join("\n")
}

// ============================================================
// 场景 1:有 @/* alias 的普通项目,.mcp.json 与 .claude/settings.json 都已有别人的内容
// ============================================================

async function scenarioAlias() {
  console.log("\n[1] alias 项目 + 已有 .mcp.json / settings.json")
  const root = mkTemp()

  write(root, "package.json", JSON.stringify({ name: "fake-app", dependencies: { next: "15.3.0", react: "19.0.0" } }, null, 2))
  write(root, "app/page.tsx", "export default function Page() { return null }\n")
  write(
    root,
    "components/ui/button.tsx",
    [
      `import * as React from 'react'`,
      `const buttonVariants = cva('inline-flex')`,
      `function Button(props) { return <button {...props} /> }`,
      `export { Button, buttonVariants }`,
      ``,
    ].join("\n"),
  )
  write(
    root,
    "components/ui/card.tsx",
    [`function Card(props) { return <div {...props} /> }`, `function CardHeader() { return null }`, `export {`, `  Card,`, `  CardHeader,`, `}`, ``].join("\n"),
  )
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }, null, 2))
  write(root, ".mcp.json", JSON.stringify({ mcpServers: { other: { command: "node", args: ["other.js"] } } }, null, 2))
  write(
    root,
    ".claude/settings.json",
    JSON.stringify(
      {
        permissions: { allow: ["Bash(ls:*)"] },
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo 我是用户本来就有的 hook" }] }],
          PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "echo fmt" }] }],
        },
      },
      null,
      2,
    ),
  )

  const out1 = await capture(() => runInit(root, {}))

  // 配置
  const cfg = readJson(root, "contactsheet.config.json")
  eq(cfg.target, "http://localhost:3000", "config.target 默认值")
  eq(cfg.port, 5199, "config.port 默认值")
  eq(cfg.appDir, "app", "config.appDir 探测为 app")
  eq(cfg.designDir, "design", "config.designDir 默认值")

  // 画板
  const btn = readFileSync(join(root, "design/Button.artboard.tsx"), "utf8")
  assert(btn.includes(`import { Button } from '@/components/ui/button'`), "Button 画板用 alias import(export { X } 形式)")
  assert(btn.includes(`render: () => <Button>示例</Button>`), "Button 画板 render 正确")
  const card = readFileSync(join(root, "design/Card.artboard.tsx"), "utf8")
  assert(card.includes(`import { Card } from '@/components/ui/card'`), "Card 画板取跨行 export { } 的第一个 PascalCase")
  assert(out1.includes("铺了 2 块画板,跳过 0 个已存在"), "统计打印:铺了 2 块")

  // .mcp.json
  const mcp = readJson(root, ".mcp.json")
  eq(mcp.mcpServers.other?.command, "node", ".mcp.json 原有 server 保留")
  eq(mcp.mcpServers.contactsheet?.type, "http", ".mcp.json contactsheet.type")
  eq(mcp.mcpServers.contactsheet?.url, "http://localhost:5199/__cs/mcp", ".mcp.json contactsheet.url")

  // .claude/settings.json
  const st = readJson(root, ".claude/settings.json")
  eq(st.permissions?.allow?.[0], "Bash(ls:*)", "settings.json 无关字段(permissions)保留")
  eq(st.hooks?.PostToolUse?.length, 1, "settings.json 其他 hook 事件保留")
  eq(st.hooks?.UserPromptSubmit?.length, 2, "UserPromptSubmit 变成 2 条(旧的 + 新的)")
  eq(st.hooks.UserPromptSubmit[0].hooks[0].command, "echo 我是用户本来就有的 hook", "用户原有 hook 原样在第一条")
  const added = st.hooks.UserPromptSubmit[1].hooks[0]
  eq(added.type, "command", "新 hook type=command")
  eq(added.command, "curl -s --noproxy '*' --max-time 1 http://localhost:5199/__cs/api/context || true", "新 hook command")

  // 幂等
  const before = snapshot(root)
  const out2 = await capture(() => runInit(root, {}))
  const after = snapshot(root)
  eq(JSON.stringify(after) === JSON.stringify(before), true, "再跑一次 runInit,所有文件内容不变")
  assert(out2.includes("铺了 0 块画板,跳过 2 个已存在"), "第二次统计:跳过 2 个已存在")
  assert(out2.includes("context hook 已存在"), "第二次不重复加 hook")
}

// ============================================================
// 场景 2:src 布局 + 没有 alias + flags 覆盖默认值
// ============================================================

async function scenarioRelativeAndFlags() {
  console.log("\n[2] src 布局 / 无 alias / flags 覆盖")
  const root = mkTemp()

  write(root, "package.json", JSON.stringify({ name: "src-app", devDependencies: { next: "15.3.0" } }, null, 2))
  write(root, "src/app/page.tsx", "export default function Page() { return null }\n")
  write(root, "src/components/ui/input.tsx", "export function Input(props) { return <input {...props} /> }\n")
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }, null, 2))

  await capture(() => runInit(root, { port: 6001, designDir: "canvas", target: "http://localhost:4000" }))

  const cfg = readJson(root, "contactsheet.config.json")
  eq(cfg.appDir, "src/app", "appDir 探测为 src/app(优先于 app)")
  eq(cfg.port, 6001, "flags.port 覆盖默认")
  eq(cfg.designDir, "canvas", "flags.designDir 覆盖默认")
  eq(cfg.target, "http://localhost:4000", "flags.target 覆盖默认")

  const input = readFileSync(join(root, "canvas/Input.artboard.tsx"), "utf8")
  assert(input.includes(`import { Input } from '../src/components/ui/input'`), "没 alias 时用相对路径 import(export function 形式)")

  eq(readJson(root, ".mcp.json").mcpServers.contactsheet.url, "http://localhost:6001/__cs/mcp", ".mcp.json 用 flags 的端口")
  const cmd = readJson(root, ".claude/settings.json").hooks.UserPromptSubmit[0].hooks[0].command
  assert(cmd.includes("http://localhost:6001/__cs/api/context"), "hook 用 flags 的端口")

  // 用户改过配置后再跑 init,用户的值要留着
  const cfgFile = join(root, "contactsheet.config.json")
  writeFileSync(cfgFile, JSON.stringify({ ...cfg, port: 7777, mine: "别动我" }, null, 2) + "\n", "utf8")
  await capture(() => runInit(root, {}))
  const cfg2 = readJson(root, "contactsheet.config.json")
  eq(cfg2.port, 7777, "不带 flags 重跑:用户手改的 port 保留")
  eq(cfg2.mine, "别动我", "不带 flags 重跑:用户自加的字段保留")
}

// ============================================================
// 场景 3:不是 Next 项目 / 不是 App Router / 没有 components/ui
// ============================================================

async function scenarioErrors() {
  console.log("\n[3] 错误路径")

  const noPkg = mkTemp()
  await expectReject(() => runInit(noPkg, {}), "没有 package.json", "没 package.json 时中止")

  const noNext = mkTemp()
  write(noNext, "package.json", JSON.stringify({ dependencies: { react: "19" } }))
  write(noNext, "app/page.tsx", "")
  await expectReject(() => runInit(noNext, {}), "没有 next", "依赖里没有 next 时中止")

  const noApp = mkTemp()
  write(noApp, "package.json", JSON.stringify({ dependencies: { next: "15" } }))
  write(noApp, "pages/index.tsx", "")
  await expectReject(() => runInit(noApp, {}), "既没有 src/app", "Pages Router 项目中止")

  const noUi = mkTemp()
  write(noUi, "package.json", JSON.stringify({ dependencies: { next: "15" } }))
  write(noUi, "app/page.tsx", "")
  const out = await capture(() => runInit(noUi, {}))
  assert(out.includes("没找到 components/ui/"), "没有 components/ui 时提示并跳过")
  assert(!existsSync(join(noUi, "design")), "没有 components/ui 时不建空 design 目录")
  assert(existsSync(join(noUi, ".mcp.json")), "没有 components/ui 也照常写 .mcp.json")

  const badJson = mkTemp()
  write(badJson, "package.json", JSON.stringify({ dependencies: { next: "15" } }))
  write(badJson, "app/page.tsx", "")
  write(badJson, ".mcp.json", "{ 这不是 JSON ")
  await expectReject(() => runInit(badJson, {}), "不是合法的 JSON", "已有 .mcp.json 坏掉时中止而不是覆盖")
  eq(readFileSync(join(badJson, ".mcp.json"), "utf8"), "{ 这不是 JSON ", "坏掉的 .mcp.json 原样没动")
}

async function expectReject(fn, needle, msg) {
  try {
    await capture(fn)
    assert(false, `${msg}(却没有报错)`)
  } catch (err) {
    assert(String(err.message).includes(needle), `${msg}${String(err.message).includes(needle) ? "" : ` —— 报错信息里没有「${needle}」:${err.message}`}`)
  }
}

// ============================================================

try {
  await scenarioAlias()
  await scenarioRelativeAndFlags()
  await scenarioErrors()
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
  console.log(`\n临时目录已清理(${temps.length} 个)`)
}

console.log(failed === 0 ? "\nselftest: 全部通过" : `\nselftest: ${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
