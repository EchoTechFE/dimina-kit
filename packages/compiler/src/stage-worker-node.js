// Resident Node worker_threads stage worker for the disk pool.
//
// One of these runs per stage (logic | view | style). It stays warm across builds
// (the pool never terminates it between compiles) and writes its stage's product
// files DIRECTLY to the shared real-disk staging dir (getTargetPath(), carried in
// the storeInfo the main thread ships). Stages write disjoint file names, so the
// three workers can write the same staging dir concurrently — exactly like dmcc's
// own index.js does.
//
// fs is NATIVE here (this bundle is built without the fs alias — see build-compiler.js),
// so dmcc's `import fs from 'node:fs'` hits real disk. worker_threads is SHIMMED for
// dmcc (isMainThread=true) so its own parentPort bootstrap stays off; we grab the REAL
// parentPort via createRequire to talk to the pool.
import { createRequire } from 'node:module'
import { runStage, resetCompilerState } from './compile-core.js'
import { resetStoreInfo, getAppId, getAppName } from '../../../dimina/fe/packages/compiler/src/env.js'

const { parentPort } = createRequire(import.meta.url)('node:worker_threads')

if (!parentPort) {
  throw new Error('[compiler] stage-worker-node.js must run inside a worker_threads Worker')
}

parentPort.on('message', async (msg) => {
  const { stage, pages, storeInfo, sourcemap } = msg || {}
  try {
    // Warm-realm hygiene: clear this worker's module-level caches so a reused worker
    // does not leak state from the previous build (same contract as the browser pool).
    resetCompilerState()
    // Restore the env singletons (paths/config/targetPath) from the main thread's setup.
    resetStoreInfo(storeInfo)
    await runStage(stage, pages, { sourcemap })
    parentPort.postMessage({ type: 'done', stage, appId: getAppId(), name: getAppName() })
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      stage,
      error: { message: error && error.message, stack: error && error.stack, name: error && error.name },
    })
  }
})
