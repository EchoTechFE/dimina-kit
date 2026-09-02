#!/usr/bin/env node

// 两类问题只在包发布出去之后才暴露，本仓自己的构建和测试都看不见：
//
//   1. exports/main/types/bin 指向的文件没进 tarball（`files` 少写一个目录就会
//      这样）。安装方一 import 就是 ERR_MODULE_NOT_FOUND，而本仓 workspace 里
//      同一个 import 一直是好的——它读的是源码目录，不是 tarball。
//   2. tarball 里混进测试文件。它们不是 API 的一部分，却出现在安装方的
//      node_modules 里，占体积、也让人以为可以 import。
//
// 所以这里拿 `npm pack --dry-run` 的真实打包清单来核对，而不是读 `files` 字段
// 猜。--ignore-scripts：只要清单，不重跑各包的 prepack 构建。

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NPM_PACKAGES } from './npm-packages.js'

// exports 的值可以是字符串，也可以嵌套条件对象（types/require/default…），
// 两种都要收集到叶子上的相对路径。
function collectTargets(node, out) {
  if (typeof node === 'string') {
    if (node.startsWith('./')) out.push(node)
    return out
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectTargets(value, out)
  }
  return out
}

const normalize = (target) => (target.startsWith('./') ? target : `./${target}`)

/**
 * 一个包声明的、安装方能直接解析到的所有文件路径。
 *
 * @param {Record<string, any>} pkgJson
 * @returns {string[]} 形如 './dist/index.js'，去重
 */
export function entryTargets(pkgJson) {
  const targets = collectTargets(pkgJson.exports, [])
  if (typeof pkgJson.main === 'string') targets.push(normalize(pkgJson.main))
  if (typeof pkgJson.types === 'string') targets.push(normalize(pkgJson.types))
  const bin = typeof pkgJson.bin === 'string' ? { [String(pkgJson.name)]: pkgJson.bin } : pkgJson.bin
  for (const value of Object.values(bin || {})) {
    if (typeof value === 'string') targets.push(normalize(value))
  }
  return [...new Set(targets)]
}

// subpath pattern（'./dist/shared/*.js'）匹配的是一组文件，只要求至少命中一个。
function patternToRegExp(target) {
  const literals = target.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${literals.join('.+')}$`)
}

const TEST_FILE = /(^|\/)(__tests__|__mocks__|fixtures|test-fixtures|types-fixture)\/|\.(test|spec)\.[^/]+$/

/**
 * 核对一个包的 package.json 与它真实的打包清单。
 *
 * @param {Record<string, any>} pkgJson
 * @param {string[]} packedPaths  npm pack 报告的 tarball 内相对路径
 * @returns {string[]} 每行一个问题；契约成立时为空
 */
export function checkPackedFiles(pkgJson, packedPaths) {
  const packed = packedPaths.map(normalize)
  const packedSet = new Set(packed)
  const problems = []

  for (const target of entryTargets(pkgJson)) {
    if (target.includes('*')) {
      const pattern = patternToRegExp(target)
      if (!packed.some((file) => pattern.test(file))) {
        problems.push(`${target} 是 exports 里的 subpath pattern，但 tarball 里没有任何文件匹配它`)
      }
      continue
    }
    if (!packedSet.has(target)) {
      problems.push(`${target} 被 package.json 声明为入口，但不在 tarball 里（检查 files 字段）`)
    }
  }

  const tests = packedPaths.filter((file) => TEST_FILE.test(file))
  if (tests.length > 0) {
    const shown = tests.slice(0, 5).join(', ')
    problems.push(`tarball 里有 ${tests.length} 个测试文件，用 files 的 "!" 规则排除掉：${shown}${tests.length > 5 ? ' …' : ''}`)
  }

  return problems
}

function packedPathsOf(dir) {
  // prepack 之类的脚本会往 stdout 写构建日志，混在 --json 前面。
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 256 * 1024 * 1024,
  })
  const start = raw.indexOf('[')
  if (start < 0) throw new Error(`npm pack --json 没有输出 JSON:\n${raw.slice(0, 500)}`)
  return JSON.parse(raw.slice(start))[0].files.map((file) => file.path)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let failed = false
  for (const { name, dir } of NPM_PACKAGES) {
    const pkgJson = JSON.parse(readFileSync(join(process.cwd(), dir, 'package.json'), 'utf8'))
    const problems = checkPackedFiles(pkgJson, packedPathsOf(dir))
    if (problems.length === 0) {
      console.log(`✅ ${name}`)
      continue
    }
    failed = true
    console.error(`❌ ${name}`)
    for (const problem of problems) console.error(`   ${problem}`)
  }
  if (failed) {
    console.error('\n发布产物契约不成立。上面每一条都会在安装方那里才炸，本仓的构建和测试看不见。')
    process.exit(1)
  }
  console.log('\n发布产物契约成立：入口都在 tarball 里，没有发出测试文件。')
}
