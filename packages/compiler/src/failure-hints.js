// Reading a raw Node failure message: which of the published error codes it earns, and
// what to tell the user when the cause is a packaging mistake rather than their project.
//
// Kept apart from pool-node.js (which pulls in worker_threads and the compiler core) so
// this classification is pure string work anyone — including scripts/test-error-codes.js
// — can import and drive directly.
import process from 'node:process'
import { COMPILER_ERROR_CODES, isCompilerErrorCode } from './error-codes.js'

// esbuild's node lib drives a spawned long-lived binary child (its "service"). When that
// child dies (spawn ENOENT in a packaged app, OOM kill, AV kill), esbuild reports every
// call with one of these two phrases — and the service NEVER restarts inside that realm,
// so the warm worker is permanently broken and must be recycled, not kept.
export function isDeadToolchainServiceError(message) {
  return /The service (was stopped|is no longer running)/.test(String(message))
}

/**
 * Map a failure message to an actionable packaging hint when it is esbuild failing to
 * spawn its native binary from inside an Electron app.asar archive. Electron patches
 * child_process.execFile for asar paths but NOT child_process.spawn (which esbuild
 * uses), so an in-archive binary path always ENOENTs at spawn even though fs sees the
 * file — the raw message points at a path that plainly exists, which is why it needs
 * a hint. Returns null for every other message.
 * @param {string} message
 * @returns {string | null}
 */
export function esbuildAsarSpawnHint(message) {
  const msg = String(message)
  if (!/app\.asar/.test(msg) || !/esbuild/i.test(msg) || !/ENOENT/.test(msg)) return null
  return 'esbuild 的原生二进制无法从 app.asar 内 spawn（Electron 只为 execFile 打 asar 补丁）：'
    + "打包配置需 asarUnpack '**/node_modules/esbuild/**' 与 '**/node_modules/@esbuild/**'，"
    + '并确保 ESBUILD_BINARY_PATH 指向 app.asar.unpacked 下的真实二进制（@dimina-kit/devkit 在 asar 内运行时会自动设置）'
}

/**
 * Map a failure message to an actionable packaging hint when it is oxc-parser's
 * "missing runtime binding" error (thrown when NEITHER the platform-native
 * `@oxc-parser/binding-<platform>` package NOR the `@oxc-parser/binding-wasm32-wasi`
 * fallback resolves at runtime). Neither package is a direct dependency of a
 * typical host, so app bundlers (e.g. electron-builder's dependency collection)
 * silently drop them — and the raw oxc message says nothing about packaging.
 * Returns null for every other message.
 * @param {string} message
 * @returns {string | null}
 */
export function oxcNativeBindingHint(message) {
  if (!/Cannot find native binding/i.test(String(message))) return null
  return 'oxc-parser 的运行时绑定没有被打进宿主应用：@dimina-kit/compiler 的 Node 编译路径需要 '
    + `@oxc-parser/binding-${process.platform}-${process.arch}（平台原生绑定）或 `
    + '@oxc-parser/binding-wasm32-wasi（wasm 兜底）二者之一实际存在于包内。'
    + '打包分发（如 electron-builder）时请把其中一个显式声明为宿主依赖，避免依赖收集时被丢弃'
}

/**
 * Which published code a raw failure message earns. The two packaging failures the hints
 * above recognize are NOT the project's fault — oxc's binding or esbuild's binary is
 * missing from the installed app — so they must not land in the compile-error bucket,
 * which hosts are told never to retry and never to fall back from.
 *
 * @param {string} message
 * @returns {string} one of COMPILER_ERROR_CODES
 */
export function errorCodeForMessage(message) {
  if (isDeadToolchainServiceError(message)) return COMPILER_ERROR_CODES.toolchainDead
  if (oxcNativeBindingHint(message) || esbuildAsarSpawnHint(message)) return COMPILER_ERROR_CODES.toolchainUnavailable
  return COMPILER_ERROR_CODES.stageError
}

/**
 * Give a raw main-thread failure the same treatment a stage reply gets: a published code,
 * the packaging hint its message earned, and the stage it came from.
 *
 * Only a code from the published table survives. A code set closer to the failure does know
 * more, but most failures here come out of node:fs, and those arrive with .code already set
 * to a libc name — leaving it alone would publish 'EACCES' or 'ENOSPC' out of the pool, and
 * the host switches on the table, so an unknown code reads as "no category at all".
 *
 * @param {unknown} err
 * @param {string | null} [stage] the stage to record when the error does not name one
 * @param {string} [forcedCode] a code the call site already knows (e.g. a write failure),
 *   used instead of reading the message
 * @returns {Error & { code: string, stage?: string }}
 */
export function tagFailure(err, stage, forcedCode) {
  const e = err instanceof Error ? err : new Error(`[compiler] ${String(err)}`)
  if (forcedCode) {
    e.code = forcedCode
  } else if (!isCompilerErrorCode(e.code)) {
    const hint = oxcNativeBindingHint(e.message) || esbuildAsarSpawnHint(e.message)
    if (hint) e.message = `${e.message} — ${hint}`
    e.code = errorCodeForMessage(e.message)
  }
  if (stage && !e.stage) e.stage = stage
  return e
}
