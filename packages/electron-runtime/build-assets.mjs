import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(fileURLToPath(import.meta.url))
const devtoolsDir = join(packageDir, '../devtools')
const workspaceDir = join(packageDir, '../..')
// pnpm injects its cross-platform JS entry for package scripts. This asset
// assembly runs outside Turbo's cached graph, so the path is not a cache input.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const pnpmCliPath = process.env.npm_execpath
if (!pnpmCliPath) {
  throw new Error('build-assets.mjs must be run from a pnpm script')
}

const inspectBuild = spawnSync(
  process.execPath,
  [pnpmCliPath, '--filter', '@dimina-kit/inspect', 'build'],
  { cwd: workspaceDir, stdio: 'inherit' },
)
if (inspectBuild.status !== 0) process.exit(inspectBuild.status ?? 1)

for (const script of [
  'build:container',
  'build:simulator',
  'build:preload',
  'build:native-host',
]) {
  const result = spawnSync(process.execPath, [pnpmCliPath, 'run', script], {
    cwd: devtoolsDir,
    stdio: 'inherit',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const assets = [
  ['dist/simulator', 'dist/simulator'],
  ['dist/service-host', 'dist/service-host'],
  ['dist/render-host', 'dist/render-host'],
  ['dist/native-host', 'dist/native-host'],
]
for (const [source, destination] of assets) {
  const destinationPath = join(packageDir, destination)
  rmSync(destinationPath, { recursive: true, force: true })
  cpSync(join(devtoolsDir, source), destinationPath, {
    recursive: true,
    force: true,
  })
}

mkdirSync(join(packageDir, 'dist/preload'), { recursive: true })
rmSync(join(packageDir, 'dist/preload/simulator.cjs'), { force: true })
cpSync(
  join(devtoolsDir, 'dist/preload/windows/simulator.cjs'),
  join(packageDir, 'dist/preload/simulator.cjs'),
  { force: true },
)
