#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NPM_PACKAGES } from './npm-packages.js'
import { toDevVersion } from './version-utils.js'

const suffix = process.env.DEV_VERSION_SUFFIX

if (!suffix) {
  console.error('DEV_VERSION_SUFFIX env var is required')
  process.exit(1)
}

for (const { dir } of NPM_PACKAGES) {
  const path = join(process.cwd(), dir, 'package.json')
  const json = JSON.parse(readFileSync(path, 'utf8'))
  const original = json.version
  // The dev channel owns the whole prerelease component. Replacing an existing
  // prerelease avoids versions such as 0.3.0-dev.6-dev.<timestamp>.
  json.version = toDevVersion(original, suffix)
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`)
  console.log(`${dir}: ${original} -> ${json.version}`)
}
