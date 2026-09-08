import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(fileURLToPath(import.meta.url))
const devtoolsDir = join(packageDir, '../devtools')
const workspaceDir = join(packageDir, '../..')
// pnpm points this at its own entry for package scripts. This asset assembly
// runs outside Turbo's cached graph, so the path is not a cache input.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const pnpmCliPath = process.env.npm_execpath
if (!pnpmCliPath) {
  throw new Error('build-assets.mjs must be run from a pnpm script')
}

// The entry is a JS file under npm and older pnpm, but a platform-native
// executable under pnpm installed through corepack (…/pnpm/<v>/pnpm-native).
// Handing that to `node` makes it parse a Mach-O/ELF header as ESM and die with
// a SyntaxError, so dispatch on what the path actually is.
const pnpmEntryIsJs = /\.[cm]?js$/i.test(pnpmCliPath)
function runPnpm(args, cwd) {
  return pnpmEntryIsJs
    ? spawnSync(process.execPath, [pnpmCliPath, ...args], { cwd, stdio: 'inherit' })
    : spawnSync(pnpmCliPath, args, { cwd, stdio: 'inherit' })
}

const inspectBuild = runPnpm(['--filter', '@dimina-kit/inspect', 'build'], workspaceDir)
if (inspectBuild.status !== 0) process.exit(inspectBuild.status ?? 1)

for (const script of [
  'build:container',
  'build:simulator',
  'build:preload',
  'build:native-host',
]) {
  const result = runPnpm(['run', script], devtoolsDir)
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
