/**
 * P4 verification (foundation.md §9): a minimal qdmp-stub host can be written
 * against the `MiniappRuntime` contract — it consumes ONLY the named kernel
 * surface (and reaches the host-controllable toolbar through `views.hostToolbar`),
 * and a real `WorkbenchContext` is assignable to it.
 */
import { describe, it, expect } from 'vitest'
import type { WorkbenchContext } from '../services/workbench-context.js'
import { asMiniappRuntime, type MiniappRuntime } from './miniapp-runtime.js'

function qdmpStubHost(rt: MiniappRuntime): string[] {
  const touched: string[] = []
  if (rt.views) touched.push('views')
  if (rt.workspace) touched.push('workspace')
  if (rt.simulatorApis) touched.push('simulatorApis')
  if (rt.connections) touched.push('connections')
  if (rt.notify) touched.push('notify')
  // The host-controllable toolbar is reached THROUGH the view manager — no 9th
  // top-level contract member. Compile-time proof the surface exists:
  if (typeof rt.views.hostToolbar.loadURL === 'function') touched.push('hostToolbar')
  if (rt.bridge !== undefined) touched.push('bridge')
  if (rt.storageApi !== undefined) touched.push('storageApi')
  if (rt.appData !== undefined) touched.push('appData')
  return touched
}

describe('MiniappRuntime contract — qdmp-stub host conformance (P4)', () => {
  it('a real WorkbenchContext is assignable to the MiniappRuntime contract', () => {
    const ctx = makeFakeContext()
    expect(asMiniappRuntime(ctx)).toBe(ctx)
  })

  it('the stub host drives the kernel surface incl. views.hostToolbar', () => {
    const touched = qdmpStubHost(asMiniappRuntime(makeFakeContext()))
    expect(touched).toEqual(
      expect.arrayContaining([
        'views',
        'workspace',
        'simulatorApis',
        'connections',
        'notify',
        'hostToolbar',
      ]),
    )
  })

  it('host-controllable toolbar is reachable through the contract (views.hostToolbar)', () => {
    const rt = asMiniappRuntime(makeFakeContext())
    expect(typeof rt.views.hostToolbar.loadURL).toBe('function')
    expect(typeof rt.views.hostToolbar.loadFile).toBe('function')
    expect(typeof rt.views.hostToolbar.hide).toBe('function')
  })
})

function makeFakeContext(): WorkbenchContext {
  const noop = (): void => {}
  return {
    views: {
      hostToolbar: {
        loadURL: async () => {},
        loadFile: async () => {},
        webContents: null,
        hide: noop,
      },
    } as unknown,
    workspace: { getSession: () => undefined } as unknown,
    simulatorApis: { has: () => false, invoke: async () => ({}) } as unknown,
    connections: { acquire: noop, get: () => undefined, all: () => [], reset: noop } as unknown,
    notify: { editorOpenFile: noop } as unknown,
    bridge: undefined,
    storageApi: undefined,
    appData: undefined,
  } as unknown as WorkbenchContext
}
