import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RuntimeAssetPaths {
  /** Directory containing simulator/, preload/, render-host/, service-host/, and native-host/. */
  root: string
  simulatorDir: string
  simulatorPreloadPath: string
  renderHostHtmlPath: string
  renderHostPreloadPath: string
  serviceHostHtmlPath: string
  serviceHostPreloadPath: string
}

const REQUIRED_ASSETS = [
  'simulator/simulator.html',
  'preload/simulator.cjs',
  'render-host/pageFrame.html',
  'render-host/preload.cjs',
  'service-host/service.html',
  'service-host/preload.cjs',
  'native-host/service/service.js',
  'native-host/render/render.js',
  'native-host/common/common.js',
  'native-host/container/pageFrame.css',
] as const

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
 * Resolve from the real module URL in Electron/Node. This is deliberately lazy:
 * a host bundler can relocate this module into the host's main bundle, in which
 * case import.meta.url no longer identifies the npm package. Such hosts pass an
 * explicit assetsRoot after copying this package's dist assets.
 */
function resolveRuntimePackageRoot(): string | null {
  if (typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')) {
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
  return null
}

function createAssetPaths(root: string): RuntimeAssetPaths {
  return {
    root,
    simulatorDir: path.join(root, 'simulator'),
    simulatorPreloadPath: path.join(root, 'preload/simulator.cjs'),
    renderHostHtmlPath: path.join(root, 'render-host/pageFrame.html'),
    renderHostPreloadPath: path.join(root, 'render-host/preload.cjs'),
    serviceHostHtmlPath: path.join(root, 'service-host/service.html'),
    serviceHostPreloadPath: path.join(root, 'service-host/preload.cjs'),
  }
}

/**
 * Resolve and validate runtime assets. `assetsRoot` is the copied package
 * `dist/` directory, not the host application's source root.
 */
export function resolveRuntimeAssetPaths(assetsRoot?: string): RuntimeAssetPaths {
  const packageRoot = assetsRoot ? null : resolveRuntimePackageRoot()
  const root = path.resolve(assetsRoot ?? (packageRoot ? path.join(packageRoot, 'dist') : ''))
  if (!assetsRoot && !packageRoot) {
    throw new Error(
      'dimina-electron-runtime assets could not be resolved after bundling; '
      + 'copy the package dist directory and pass its absolute path as assetsRoot',
    )
  }
  const missing = REQUIRED_ASSETS.filter((relativePath) =>
    !fs.existsSync(path.join(root, relativePath)))
  if (missing.length > 0) {
    throw new Error(
      `dimina-electron-runtime assetsRoot is incomplete (${root}); missing: ${missing.join(', ')}`,
    )
  }
  return createAssetPaths(root)
}
