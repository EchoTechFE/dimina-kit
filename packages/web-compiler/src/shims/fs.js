// node:fs / fs -> whatever the caller injects; there is NO built-in backend.
//
// The compiler is all `import fs from 'node:fs'` + `fs.xxx`, aliased to this
// shim. compileMiniApp({ fs }) sets the active backend via setFs() for the
// duration of one compile; with nothing injected, every fs.* call throws. This
// is what lets web-compiler carry no fs implementation of its own — the host
// brings its own node:fs replacement (memfs, or anything meeting the contract).
let current = null

export function setFs(impl) { current = impl }
export function resetFs() { current = null }
export function getFs() { return current }

// Forward a method to the injected backend. Every method — including lstat /
// realpath / access — forwards to the real fs; there are NO synthetic fallbacks.
// (An identity realpath, a no-op access, or lstat aliased to stat would hand the
// compiler wrong semantics silently.) A method the backend lacks throws.
const call = (name) => (...args) => {
  if (!current) throw new Error('[web-compiler] no fs backend injected — call compileMiniApp({ fs })')
  const fn = current[name]
  if (typeof fn === 'function') return fn.apply(current, args)
  throw new Error(`[web-compiler] injected fs is missing ${name}()`)
}

export const existsSync = call('existsSync')
export const readFileSync = call('readFileSync')
export const writeFileSync = call('writeFileSync')
export const mkdirSync = call('mkdirSync')
export const rmSync = call('rmSync')
export const rmdirSync = call('rmdirSync')
export const readdirSync = call('readdirSync')
export const copyFileSync = call('copyFileSync')
export const statSync = call('statSync')
export const lstatSync = call('lstatSync')
export const unlinkSync = call('unlinkSync')
export const renameSync = call('renameSync')
export const appendFileSync = call('appendFileSync')
export const realpathSync = call('realpathSync')
export const accessSync = call('accessSync')
export const readlinkSync = call('readlinkSync')
export const watch = call('watch')

// Async API — forwarded to the injected fs.promises if present. The compiler
// uses no async fs; this only satisfies the node:fs/promises alias.
export const promises = new Proxy({}, {
  get: (_t, prop) => (...args) => {
    if (!current || !current.promises || typeof current.promises[prop] !== 'function') {
      throw new Error(`[web-compiler] injected fs has no promises.${String(prop)}()`)
    }
    return current.promises[prop](...args)
  },
})

const fs = {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, rmdirSync,
  readdirSync, copyFileSync, statSync, lstatSync, unlinkSync, renameSync,
  appendFileSync, realpathSync, accessSync, readlinkSync, watch, promises,
}
export default fs
