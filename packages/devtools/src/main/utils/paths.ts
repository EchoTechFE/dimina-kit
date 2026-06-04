import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// Hardcoded relative jumps like '../../dist/renderer' break under the
// esbuild single-file bundle (dist/main/index.bundle.js): every inlined
// module ends up at the bundle's depth instead of its tsc location, so
// the math goes off by a directory. Walk up to this package's own
// package.json so the resolver works for tsc multi-file, the bundle,
// npm/pnpm node_modules, and asar packaging alike.
function resolveDevtoolsPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  const root = path.parse(dir).root
  while (dir !== root) {
    const pkgPath = path.join(dir, 'package.json')
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      if (pkg.name === '@dimina-kit/devtools') return dir
    } catch {}
    dir = path.dirname(dir)
  }
  throw new Error('@dimina-kit/devtools package root not found from ' + fileURLToPath(import.meta.url))
}

export const devtoolsPackageRoot = resolveDevtoolsPackageRoot()

export const rendererDir = path.join(devtoolsPackageRoot, 'dist/renderer')

export const defaultPreloadPath = path.join(devtoolsPackageRoot, 'dist/preload/windows/simulator.js')

/**
 * Resolve the CommonJS sibling (`*.cjs`) of a simulator preload bundle.
 *
 * The default `<webview>` simulator path consumes the preload as a session
 * frame preload, where Electron always loads it as CommonJS. The native-host
 * simulator runs in a top-level WebContentsView whose `webPreferences.preload`
 * obeys the `.js` + `"type":"module"` ESM rule — so the `.js` bundle would fail
 * with `require is not defined`. We ship a byte-identical `.cjs` copy
 * (build:preload emits both) and hand the WCV the `.cjs` sibling. If a host
 * supplies a custom `.js` preload, we swap the extension; an already-`.cjs`
 * path (or any non-`.js`) is returned unchanged.
 */
export function cjsSiblingPreloadPath(preloadPath: string): string {
  return preloadPath.endsWith('.js')
    ? preloadPath.slice(0, -'.js'.length) + '.cjs'
    : preloadPath
}

/**
 * Preload bundle for the main window, settings window, and the settings /
 * popover overlay WebContentsViews. Exposes `window.devtools.ipc` via
 * contextBridge so the renderer never needs `window.require('electron')`.
 */
export const mainPreloadPath = path.join(devtoolsPackageRoot, 'dist/preload/windows/main.cjs')

export const simulatorDir = path.join(devtoolsPackageRoot, 'dist/simulator')

export function getRendererDir(): string {
  return rendererDir
}

export function getPreloadDir(): string {
  return path.join(devtoolsPackageRoot, 'dist/preload')
}

export function getRendererHtml(filename: string): string {
  return path.join(rendererDir, filename)
}
