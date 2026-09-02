// Type-checks every published entry point the way a downstream TypeScript app
// imports it. The `@ts-expect-error` lines are the real guard: if an entry
// silently loses its declarations (missing `types` condition, an emit that
// degrades to `any`), the deliberately wrong call stops erroring and tsc fails
// this file with "unused '@ts-expect-error' directive".

import { collectOutputs, compileMiniApp, STAGE_NAMES } from '@dimina-kit/compiler'
import { COMPILER_BROWSER_ASSETS, resolveBrowserAssets } from '@dimina-kit/compiler/browser-assets'
import { initToolchain } from '@dimina-kit/compiler/browser'
import { QD_FILE_TYPES, hasExt, resolveFileTypes } from '@dimina-kit/compiler/file-types'
import { createCompilerPool } from '@dimina-kit/compiler/pool'
import { createNodeCompilerPool } from '@dimina-kit/compiler/pool-node'
import '@dimina-kit/compiler/stage-worker'
import { installOxc } from '@dimina-kit/compiler/toolchain'

const stages: string[] = STAGE_NAMES
void stages

const assetNames: string[] = COMPILER_BROWSER_ASSETS.map(asset => asset.name)
void assetNames
const assetDir: string = resolveBrowserAssets('/pkg/dist/compile-core.browser.js').dir
void assetDir
// @ts-expect-error resolveBrowserAssets takes the resolved entry path, not the asset list
resolveBrowserAssets(COMPILER_BROWSER_ASSETS)

const outputs: Record<string, string | Uint8Array> = collectOutputs({ fs: {}, targetPath: '/dist' })

const { templateExts } = resolveFileTypes(QD_FILE_TYPES)
const isTemplate: boolean = hasExt('pages/index/index.qdml', templateExts)
void isTemplate
// The published dialect is frozen at runtime, so the declarations have to say so —
// otherwise "just add one more extension" type-checks and throws in the browser.
// @ts-expect-error QD_FILE_TYPES' lists are readonly
QD_FILE_TYPES.template?.push('qdx')
// @ts-expect-error hasExt takes the extension list, not a single extension
hasExt('pages/index/index.qdml', '.qdml')
void outputs
// @ts-expect-error products are text OR bytes; a downstream must narrow before treating one as a string
const textOnly: Record<string, string> = collectOutputs({ fs: {}, targetPath: '/dist' })
void textOnly
// @ts-expect-error targetPath is required
collectOutputs({ fs: {} })

const ready: Promise<void> = initToolchain()
void ready
// @ts-expect-error initToolchain takes no arguments
initToolchain('oxc')

installOxc({ parseSync: () => undefined })
// @ts-expect-error the oxc module bag is an object, not its specifier
installOxc('oxc-parser')

const pool = createCompilerPool({
  createWorker: () => new Worker('/stage-worker.browser.js', { type: 'module' }),
  toolchainSetupURL: '/toolchain-setup.mjs',
  onLog: (entry) => {
    // The level is one of the three console methods the stage worker patches —
    // a widened `string` here would let a downstream switch miss cases silently.
    const level: 'log' | 'warn' | 'error' = entry.level
    const line: string = `[${entry.stage}] ${level}: ${entry.message}`
    void line
  },
})
// @ts-expect-error createWorker is required
createCompilerPool({ toolchainSetupURL: '/toolchain-setup.mjs' })
// @ts-expect-error both required options live in the (required) options object
createCompilerPool()
// @ts-expect-error toolchainSetupURL is a URL string
createCompilerPool({ createWorker: () => new Worker('/w.js'), toolchainSetupURL: 42 })

export async function compileOnce(): Promise<string> {
  const warm: Promise<void> = pool.warmup()
  await warm
  const result = await pool.compile({ files: { 'app.json': '{}' } })
  const appId: string = result.appId
  // @ts-expect-error the compile result carries appId/name/files only
  void result.bundle
  await pool.dispose()
  return appId
}

const nodePool = createNodeCompilerPool({ stages: ['logic'] })
void nodePool

// The published dialect must go into the compile entries exactly as the README shows
// it. Its lists are frozen, so an entry still asking for mutable `string[]` rejects
// it with TS2322 — a downstream would have to copy the arrays to get past its own
// type-check, which is how each host ends up with its own drifting copy again.
void pool.compile({ files: { 'app.json': '{}' }, workPath: '/project', options: { fileTypes: QD_FILE_TYPES } })
void compileMiniApp({ fs: {}, workPath: '/project', options: { fileTypes: QD_FILE_TYPES } })
void nodePool.build('/out', '/project', true, { fileTypes: QD_FILE_TYPES })
// @ts-expect-error stages is a list of stage names
createNodeCompilerPool({ stages: 'logic' })
