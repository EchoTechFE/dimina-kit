#!/usr/bin/env node

// dimina/fe 是 submodule 里的一个独立 pnpm workspace，它的 package.json 声明
// packageManager: pnpm@12.2.0，和本仓根声明的版本不是同一个。pnpm 一进这个目录
// 就会去下载并切换到它声明的那个版本，而 runner 上这次切换会 exec 下载包里的
// pnpm.exe——Windows 二进制——于是 Linux 和 macOS 上直接以
// `Syntax error: ")" unexpected` 退出 2。Install dimina/fe deps 和随后的
// build:container 都断在这里。
//
// pnpm 12 已经没有能关掉版本自管的配置项了：--config.manage-package-manager-versions、
// npm_config_* 环境变量、--pm-on-fail 都不阻止切换，唯一的开关得写进那个 workspace
// 自己的 pnpm-workspace.yaml，而那是 submodule 的文件。所以这里在 runner 的工作副本
// 上摘掉这个字段，让 submodule 用 runner 上已经装好的 pnpm。改动不提交，也不进
// submodule。
//
// 两边版本一致（或 submodule 自己去掉了这个字段）时什么都不做，可以重复跑。

import { readFileSync, writeFileSync } from 'node:fs'

const FE_MANIFEST = 'dimina/fe/package.json'

const source = readFileSync(FE_MANIFEST, 'utf8')
const declared = JSON.parse(source).packageManager

if (!declared) {
  console.log(`${FE_MANIFEST} 没有声明 packageManager，无需处理`)
  process.exit(0)
}

const rootDeclared = JSON.parse(readFileSync('package.json', 'utf8')).packageManager

if (declared === rootDeclared) {
  console.log(`dimina/fe 与本仓根都是 ${declared}，不会触发版本切换，无需处理`)
  process.exit(0)
}

// 只删这一行，其余原样保留：这份 manifest 属于 submodule，不做格式化重写。
const stripped = source.replace(/^[ \t]*"packageManager":[ \t]*"[^"]*",?\r?\n/m, '')

if (stripped === source) {
  throw new Error(`在 ${FE_MANIFEST} 里没找到可删除的 packageManager 行`)
}

JSON.parse(stripped)
writeFileSync(FE_MANIFEST, stripped)

console.log(
  `已在 runner 的工作副本上移除 dimina/fe 的 packageManager（${declared}），`
  + `改用本仓根的 ${rootDeclared}`,
)
