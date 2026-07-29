import { cpSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(fileURLToPath(import.meta.url))
const devtoolsDir = join(packageDir, '../devtools')
const workspaceDir = join(packageDir, '../..')

const inspectBuild = spawnSync(
  'pnpm',
  ['--filter', '@dimina-kit/inspect', 'build'],
  { cwd: workspaceDir, stdio: 'inherit' },
)
if (inspectBuild.status !== 0) process.exit(inspectBuild.status ?? 1)

for (const script of [
  'build:container',
  'build:simulator',
  'build:preload',
  'build:native-host',
]) {
  const result = spawnSync('pnpm', ['run', script], {
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
  cpSync(join(devtoolsDir, source), join(packageDir, destination), {
    recursive: true,
    force: true,
  })
}

mkdirSync(join(packageDir, 'dist/preload'), { recursive: true })
cpSync(
  join(devtoolsDir, 'dist/preload/windows/simulator.cjs'),
  join(packageDir, 'dist/preload/simulator.cjs'),
  { force: true },
)
