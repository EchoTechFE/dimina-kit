/**
 * Shared test scaffolding for the Phase 2 "global mirror" test suites
 * (`global-mirror.test.ts` + `global-mirror-bugfixes.test.ts`), split out so
 * neither test file needs to duplicate these fixtures. Pure test scaffolding,
 * not the code under test — see network-forward/index.test.ts for the
 * canonical source these were originally copied from.
 */
import { vi } from 'vitest'
import type { WebContents } from 'electron'

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

type DbgListener = (event: unknown, method: string, params: unknown) => void

export function makeSimWc() {
  let attached = false
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const sendCommand = vi.fn((_method: string, _params?: object) => Promise.resolve({}) as Promise<unknown>)
  const dbg = {
    isAttached: () => attached,
    attach: vi.fn(() => { attached = true }),
    detach: vi.fn(() => { attached = false }),
    sendCommand,
    on: (ev: string, fn: (...args: unknown[]) => void) => {
      if (!listeners.has(ev)) listeners.set(ev, new Set())
      listeners.get(ev)!.add(fn)
    },
    removeListener: (ev: string, fn: (...args: unknown[]) => void) => {
      listeners.get(ev)?.delete(fn)
    },
  }
  const wc = {
    isDestroyed: () => false,
    debugger: dbg,
    once: () => {},
    removeListener: () => {},
  } as unknown as WebContents
  const emitMessage = (method: string, params: unknown) => {
    for (const fn of listeners.get('message') ?? []) (fn as DbgListener)({}, method, params)
  }
  return { wc, dbg, sendCommand, emitMessage }
}

export function makeServiceWc() {
  const exec = vi.fn((_script: string, _userGesture?: boolean) => Promise.resolve(undefined))
  const wc = { isDestroyed: () => false, executeJavaScript: exec } as unknown as WebContents
  return { wc, exec }
}

/**
 * A DevTools FRONT-END host wc. The injected dispatch script returns `true` when
 * `window.DevToolsAPI.dispatchMessage` is "present", so the fake resolves the
 * configured value to simulate the API being ready (true) or still booting
 * (false → forwarder retries / falls back).
 */
export function makeDevtoolsWc(
  apiReady: boolean | (() => boolean) = true,
  isLoading: () => boolean = () => false,
) {
  const exec = vi.fn((_script: string, _userGesture?: boolean) =>
    Promise.resolve(typeof apiReady === 'function' ? apiReady() : apiReady))
  const destroyedListeners = new Set<() => void>()
  const wc = {
    isDestroyed: () => false,
    isLoading,
    getURL: () => 'devtools://devtools/bundled/devtools_app.html',
    executeJavaScript: exec,
    once: (ev: string, fn: () => void) => { if (ev === 'destroyed') destroyedListeners.add(fn) },
    removeListener: (ev: string, fn: () => void) => { if (ev === 'destroyed') destroyedListeners.delete(fn) },
  } as unknown as WebContents
  const emitDestroyed = () => { for (const fn of [...destroyedListeners]) fn() }
  return { wc, exec, emitDestroyed }
}

/** Decode the messages array embedded in a buildDispatchScript() source. */
export function decodeDispatched(script: string): Array<{ method: string; params: unknown }> {
  const start = script.indexOf('JSON.parse("')
  if (start < 0) return []
  let i = start + 'JSON.parse('.length
  const open = i
  i++
  for (; i < script.length; i++) {
    if (script[i] === '\\') { i++; continue }
    if (script[i] === '"') break
  }
  const literal = script.slice(open, i + 1)
  const inner = JSON.parse(literal) as string
  const arr = JSON.parse(inner) as string[]
  return arr.map((s) => JSON.parse(s) as { method: string; params: unknown })
}

/** All events mirrored into a fake devtools host wc across every exec() call. */
export function allDispatched(exec: ReturnType<typeof vi.fn>): Array<{ method: string; params: unknown }> {
  return exec.mock.calls.flatMap((c) => decodeDispatched(String(c[0])))
}
