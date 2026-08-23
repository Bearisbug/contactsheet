// 构建:dist/cli.js(node)+ dist/canvas/app.js(browser)+ 静态文件拷贝
import { build, context } from "esbuild"
import { cpSync, mkdirSync } from "node:fs"

const watch = process.argv.includes("--watch")

const nodeOpts = {
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module';const require = createRequire(import.meta.url);" },
  packages: "external",
  sourcemap: true,
}

const canvasOpts = {
  entryPoints: ["src/canvas/app.ts"],
  outfile: "dist/canvas/app.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: true,
}

function copyStatic() {
  mkdirSync("dist/canvas", { recursive: true })
  cpSync("src/canvas/index.html", "dist/canvas/index.html")
  cpSync("src/canvas/style.css", "dist/canvas/style.css")
  // 模块样式:各自独立文件,并行开发时不会互相覆盖
  for (const n of ["pins", "wall", "sidebar", "select"]) {
    cpSync(`src/canvas/style-${n}.css`, `dist/canvas/style-${n}.css`)
  }
  // logo 与 favicon(来源 assets/logo.png,处理脚本一次性,产物直接进库)
  cpSync("src/canvas/logo.png", "dist/canvas/logo.png")
  cpSync("src/canvas/favicon.png", "dist/canvas/favicon.png")
}

if (watch) {
  const [a, b] = await Promise.all([context(nodeOpts), context(canvasOpts)])
  await Promise.all([a.watch(), b.watch()])
  copyStatic()
  console.log("esbuild watching…")
} else {
  await Promise.all([build(nodeOpts), build(canvasOpts)])
  copyStatic()
  console.log("built dist/")
}
