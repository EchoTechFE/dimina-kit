// Type-checks every published entry point the way a downstream TypeScript app
// imports it. The `@ts-expect-error` lines are the real guard: if an entry
// silently loses its declarations (missing `types` condition, an emit that
// degrades to `any`), the deliberately wrong call stops erroring and tsc fails
// this file with "unused '@ts-expect-error' directive".

import { collectOutputs, STAGE_NAMES } from '@dimina-kit/compiler'
import { initToolchain } from '@dimina-kit/compiler/browser'
import { createCompilerPool } from '@dimina-kit/compiler/pool'
import { createNodeCompilerPool } from '@dimina-kit/compiler/pool-node'
import '@dimina-kit/compiler/stage-worker'
import { installOxc } from '@dimina-kit/compiler/toolchain'

const stages: string[] = STAGE_NAMES
void stages

const outputs: Record<string, string> = collectOutputs({ fs: {}, targetPath: '/dist' })
void outputs
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
    const line: string = `[${entry.stage}] ${entry.level}: ${entry.message}`
    void line
  },
})
// @ts-expect-error createWorker is required
createCompilerPool({ toolchainSetupURL: '/toolchain-setup.mjs' })
// @ts-expect-error toolchainSetupURL is a URL string
createCompilerPool({ createWorker: () => new Worker('/w.js'), toolchainSetupURL: 42 })

export async function compileOnce(): Promise<string> {
  await pool.warmup()
  const result = await pool.compile({ files: { 'app.json': '{}' } })
  const appId: string = result.appId
  // @ts-expect-error the compile result carries appId/name/files only
  void result.bundle
  await pool.dispose()
  return appId
}

const nodePool = createNodeCompilerPool({ stages: ['logic'] })
void nodePool
// @ts-expect-error stages is a list of stage names
createNodeCompilerPool({ stages: 'logic' })
