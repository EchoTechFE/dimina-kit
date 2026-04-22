#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGES = [
  { name: '@dimina-kit/devkit', dir: 'packages/devkit' },
  { name: '@dimina-kit/devtools', dir: 'packages/devtools' },
]

const channel = process.env.CHANNEL
const npmTag = process.env.NPM_TAG
const ghOutput = process.env.GITHUB_OUTPUT

if (!['dev', 'release'].includes(channel)) {
  console.error(`Invalid CHANNEL: ${channel}`)
  process.exit(1)
}
if (!npmTag) {
  console.error('NPM_TAG env var is required')
  process.exit(1)
}

const changes = []

for (const pkg of PACKAGES) {
  const pkgJson = JSON.parse(
    readFileSync(join(process.cwd(), pkg.dir, 'package.json'), 'utf8'),
  )
  const localVersion = pkgJson.version

  let remoteVersion = null
  if (channel === 'release') {
    try {
      remoteVersion = execFileSync('npm', ['view', pkg.name, 'version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    } catch {
      remoteVersion = null
    }

    if (remoteVersion === localVersion) {
      console.log(`Skipping ${pkg.name}: version ${localVersion} already on npm`)
      continue
    }
  }

  console.log(`Publishing ${pkg.name}: ${remoteVersion ?? 'none'} -> ${localVersion} (tag: ${npmTag})`)
  execFileSync(
    'pnpm',
    ['publish', '--no-git-checks', '--access', 'public', '--tag', npmTag, '--ignore-scripts'],
    { cwd: pkg.dir, stdio: 'inherit' },
  )
  changes.push({ name: pkg.name, from: remoteVersion, to: localVersion })
}

let notes
if (changes.length === 0) {
  notes = '_No npm packages were updated._'
} else {
  notes = '## NPM packages\n\n'
  for (const c of changes) {
    if (c.from) {
      notes += `- \`${c.name}\`: \`${c.from}\` → \`${c.to}\`\n`
    } else {
      notes += `- \`${c.name}\`: \`${c.to}\` (initial)\n`
    }
  }
}

console.log('\n--- Release notes ---')
console.log(notes)

if (ghOutput) {
  appendFileSync(ghOutput, `changes=${JSON.stringify(changes)}\n`)
  const delim = `EOF_NOTES_${randomUUID()}`
  appendFileSync(ghOutput, `notes<<${delim}\n${notes}\n${delim}\n`)
}
