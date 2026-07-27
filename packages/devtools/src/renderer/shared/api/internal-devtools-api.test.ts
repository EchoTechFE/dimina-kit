/**
 * Renderer wrapper for opening the main window's detached Chrome DevTools —
 * Phase 0 of the standalone floating CDP debug panel: the simulator toolbar's
 * "debug" button opens the plain `openDevTools({ mode: 'detach' })` window
 * (later phases swap this for a dedicated host window, but the wire contract
 * stays the same).
 *
 * CONTRACT (public API on internal-devtools-api.ts):
 *
 *   export function openInternalDevtools(): Promise<void>
 *
 * It must drive the 'internal-devtools:open' wire channel
 * (InternalDevtoolsChannel.Open — registered in
 * src/main/ipc/internal-devtools.ts) via the ipc-transport invoke path, with
 * no extra arguments.
 *
 * Real bug this catches: a debug button wired to a wrapper that hits the
 * WRONG wire name (a typo'd channel string) silently opens nothing — this
 * pins the wrapper to the exact channel the main-process handler listens on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const transport = vi.hoisted(() => ({
  invoke: vi.fn((_channel: string, ..._args: unknown[]) => Promise.resolve(undefined)),
  invokeStrict: vi.fn((_channel: string, ..._args: unknown[]) => Promise.resolve(undefined)),
  send: vi.fn(),
  sendSync: vi.fn(),
  on: vi.fn(() => () => {}),
}))

vi.mock('./ipc-transport', () => transport)

import * as internalDevtoolsApi from './internal-devtools-api'

type InvokeCall = [channel: string, ...args: unknown[]]

function allInvokeCalls(): InvokeCall[] {
  return [
    ...(transport.invoke.mock.calls as unknown as InvokeCall[]),
    ...(transport.invokeStrict.mock.calls as unknown as InvokeCall[]),
  ]
}

beforeEach(() => {
  transport.invoke.mockClear()
  transport.invokeStrict.mockClear()
  transport.send.mockClear()
})

describe("internal-devtools-api: openInternalDevtools drives 'internal-devtools:open'", () => {
  it('exports an openInternalDevtools function', () => {
    expect(
      typeof (internalDevtoolsApi as Record<string, unknown>).openInternalDevtools,
      'internal-devtools-api.ts must export the renderer wrapper — without it the debug button has no sanctioned way onto the wire (ipc-transport is the only allowed touchpoint)',
    ).toBe('function')
  })

  it("openInternalDevtools() invokes the 'internal-devtools:open' wire channel with no extra args", async () => {
    const fn = (internalDevtoolsApi as Record<string, unknown>).openInternalDevtools as
      | (() => Promise<void>)
      | undefined
    expect(typeof fn).toBe('function')

    await fn!()

    const calls = allInvokeCalls().filter(([channel]) => channel === 'internal-devtools:open')
    expect(
      calls.length,
      "must invoke 'internal-devtools:open' — a hand-typed wrong channel string would silently open nothing",
    ).toBeGreaterThanOrEqual(1)
    expect(
      calls[0],
      'no extra arguments belong on this channel — the main handler takes none',
    ).toEqual(['internal-devtools:open'])
  })
})
