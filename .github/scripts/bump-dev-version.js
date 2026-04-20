#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGES = ['packages/devkit', 'packages/devtools']
const suffix = process.env.DEV_VERSION_SUFFIX

if (!suffix) {
  console.error('DEV_VERSION_SUFFIX env var is required')
  process.exit(1)
}

for (const pkg of PACKAGES) {
  const path = join(process.cwd(), pkg, 'package.json')
  const json = JSON.parse(readFileSync(path, 'utf8'))
  const original = json.version
  json.version = `${original}-${suffix}`
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`)
  console.log(`${pkg}: ${original} -> ${json.version}`)
}
