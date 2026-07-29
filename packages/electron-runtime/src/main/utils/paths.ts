import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function isRuntimePackage(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      name?: string
    }
    return pkg.name === 'dimina-electron-runtime'
  } catch {
    return false
  }
}

function walkForRuntimePackage(start: string): string | null {
  let dir = path.resolve(start)
  const root = path.parse(dir).root
  while (dir !== root) {
    if (isRuntimePackage(dir)) return dir
    dir = path.dirname(dir)
  }
  return null
}

/**
 * Resolve from the real module URL in Electron/Node. Vite's test transform uses
 * a non-file import.meta URL, so the workspace candidates are an explicit
 * source-test fallback only; published/runtime execution always takes the first
 * branch and finds the package by its own package.json.
 */
function resolveRuntimePackageRoot(): string {
  if (import.meta.url.startsWith('file:')) {
    const resolved = walkForRuntimePackage(path.dirname(fileURLToPath(import.meta.url)))
    if (resolved) return resolved
  }
  for (const candidate of [
    process.cwd(),
    path.join(process.cwd(), 'packages/electron-runtime'),
    path.join(process.cwd(), '../electron-runtime'),
  ]) {
    const resolved = walkForRuntimePackage(candidate)
    if (resolved) return resolved
    if (isRuntimePackage(candidate)) return candidate
  }
  throw new Error('dimina-electron-runtime package root could not be resolved')
}

export const runtimePackageRoot = resolveRuntimePackageRoot()

export const runtimeSimulatorDir = path.join(runtimePackageRoot, 'dist/simulator')
export const runtimeSimulatorPreloadPath = path.join(
  runtimePackageRoot,
  'dist/preload/simulator.cjs',
)
