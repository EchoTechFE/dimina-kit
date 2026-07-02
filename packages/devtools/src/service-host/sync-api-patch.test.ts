/**
 * sync-api-patch — SYNC storage write notify (final-contract.md §2).
 *
 * `setStorageSync`/`removeStorageSync`/`clearStorageSync` write `localStorage`
 * directly inside the service-host window and never round-trip through main
 * (unlike the async path), so without a notify hook the Storage panel would
 * only reflect these writes after a manual reload. `patchNamespace` must wrap
 * each of the three sync mutators to call the underlying sync-impl AND THEN
 * post a `storageChanged` container message over `DiminaServiceBridge`.
 *
 * Pinned contract:
 *   - `setStorageSync(key, data)` → localStorage set under `${appId}_${key}`,
 *     AND `DiminaServiceBridge.invoke({ type:'storageChanged', target:'container',
 *     body:{ op:'set', key: '${appId}_${key}', value: <encoded> } })`.
 *   - `removeStorageSync(key)` → notify with `{ op:'remove', key }`.
 *   - `clearStorageSync()` → notify with `{ op:'clear' }`.
 *   - No `DiminaServiceBridge` global (pool-warming stub / non-native runtime)
 *     → the sync write still happens, but nothing throws.
 *
 * The module patches whatever `wx`/`dd`/`qd` global exists AND reads
 * `__diminaSpawnContext` at MODULE TOP-LEVEL import time, so each case
 * `vi.resetModules()` + sets the globals BEFORE a fresh dynamic import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type AnyFn = (...args: unknown[]) => unknown
interface PatchedNamespace {
  setStorageSync: (key: string, data: unknown) => void
  removeStorageSync: (key: string) => void
  clearStorageSync: () => void
}

const ORIGINAL_SPAWN_CONTEXT = (globalThis as unknown as { __diminaSpawnContext?: unknown }).__diminaSpawnContext
const ORIGINAL_BRIDGE = (globalThis as unknown as { DiminaServiceBridge?: unknown }).DiminaServiceBridge
const ORIGINAL_WX = (globalThis as unknown as { wx?: unknown }).wx

/**
 * Reset the module registry, stamp the globals the module reads at import
 * time, then import it fresh so `patchNamespace(globalScope.wx)` runs against
 * OUR `wx` stub. Returns the (now-patched) `wx` object.
 */
async function loadPatchedWx(invoke: AnyFn | undefined): Promise<PatchedNamespace> {
  vi.resetModules()
  ;(globalThis as unknown as { __diminaSpawnContext: unknown }).__diminaSpawnContext = { appId: 'wxAPP' }
  ;(globalThis as unknown as { wx: unknown }).wx = {}
  if (invoke) {
    ;(globalThis as unknown as { DiminaServiceBridge: unknown }).DiminaServiceBridge = { invoke }
  } else {
    delete (globalThis as unknown as { DiminaServiceBridge?: unknown }).DiminaServiceBridge
  }
  await import('./sync-api-patch.js')
  return (globalThis as unknown as { wx: PatchedNamespace }).wx
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
  ;(globalThis as unknown as { __diminaSpawnContext?: unknown }).__diminaSpawnContext = ORIGINAL_SPAWN_CONTEXT
  ;(globalThis as unknown as { DiminaServiceBridge?: unknown }).DiminaServiceBridge = ORIGINAL_BRIDGE
  ;(globalThis as unknown as { wx?: unknown }).wx = ORIGINAL_WX
})

describe('sync-api-patch — SYNC storage write notify (final-contract §2)', () => {
  it('setStorageSync writes localStorage under the ${appId}_ prefix and notifies main with a SET storageChanged message', async () => {
    const invoke = vi.fn()
    const wx = await loadPatchedWx(invoke)

    wx.setStorageSync('k', { a: 1 })

    expect(localStorage.getItem('wxAPP_k')).toBe('{"a":1}')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith({
      type: 'storageChanged',
      target: 'container',
      body: { op: 'set', key: 'wxAPP_k', value: '{"a":1}' },
    })
  })

  it('setStorageSync with a primitive value encodes it as a plain string (matches sync-impls encoding)', async () => {
    const invoke = vi.fn()
    const wx = await loadPatchedWx(invoke)

    wx.setStorageSync('k', 'plain-string')

    expect(localStorage.getItem('wxAPP_k')).toBe('plain-string')
    expect(invoke).toHaveBeenCalledWith({
      type: 'storageChanged',
      target: 'container',
      body: { op: 'set', key: 'wxAPP_k', value: 'plain-string' },
    })
  })

  it('removeStorageSync notifies main with a REMOVE storageChanged message', async () => {
    const invoke = vi.fn()
    const wx = await loadPatchedWx(invoke)

    wx.removeStorageSync('k')

    expect(invoke).toHaveBeenCalledWith({
      type: 'storageChanged',
      target: 'container',
      body: { op: 'remove', key: 'wxAPP_k' },
    })
  })

  it('clearStorageSync notifies main with a CLEAR storageChanged message', async () => {
    const invoke = vi.fn()
    const wx = await loadPatchedWx(invoke)

    wx.clearStorageSync()

    expect(invoke).toHaveBeenCalledWith({
      type: 'storageChanged',
      target: 'container',
      body: { op: 'clear' },
    })
  })

  it('does NOT throw when DiminaServiceBridge is absent (pool-warming stub / non-native runtime) — the sync write still lands', async () => {
    const wx = await loadPatchedWx(undefined)

    expect(() => wx.setStorageSync('k', 'v')).not.toThrow()
    expect(localStorage.getItem('wxAPP_k')).toBe('v')

    expect(() => wx.removeStorageSync('k')).not.toThrow()
    expect(() => wx.clearStorageSync()).not.toThrow()
  })
})
