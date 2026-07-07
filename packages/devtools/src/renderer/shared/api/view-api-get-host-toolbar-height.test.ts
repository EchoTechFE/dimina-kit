/**
 * Host-toolbar height replay — renderer api wrapper.
 *
 * CONTRACT (public API on view-api.ts):
 *
 *   export function getHostToolbarHeight(): Promise<number | undefined>
 *
 * It must drive the 'view:host-toolbar:get-height' wire channel (the
 * invoke handler pinned in src/main/ipc/views-host-toolbar-get-height.test.ts)
 * via the ipc-transport invoke path and hand the main-retained height back to
 * the caller.
 *
 * Real bug this catches: the renderer currently has NO pull path for the
 * toolbar height at all — view-api.ts only exposes the push subscription
 * (`onHostToolbarHeightChanged`). The project view mounts its listener AFTER
 * the height notify may already have fired (cold start; ALWAYS on
 * close-project → reopen), and the toolbar's size-advertiser deduplicates so
 * the value is never re-pushed: without this wrapper the placeholder is stuck
 * at 0. The component test (project-runtime-host-toolbar-replay.test.tsx)
 * pins that mount calls the wrapper; THIS test pins the wrapper to the wire.
 *
 * The export is reached via the module namespace (not a direct named import),
 * same convention as settings-api-set-visible.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const transport = vi.hoisted(() => ({
  // Record both invoke flavors — the contract is "an invoke-style round trip
  // on the right channel that resolves to the main-side value". Which helper
  // carries it is unspecified (note: the lenient `invoke`
  // swallows main-side errors into `undefined`, which the mounting component
  // must tolerate — pinned in the component suite).
  invoke: vi.fn((_channel: string, ..._args: unknown[]) => Promise.resolve<unknown>(undefined)),
  invokeStrict: vi.fn((_channel: string, ..._args: unknown[]) => Promise.resolve<unknown>(undefined)),
  send: vi.fn(),
  sendSync: vi.fn(),
  on: vi.fn(() => () => {}),
}))

vi.mock('./ipc-transport', () => transport)

import * as viewApi from './view-api'

// Wire name asserted literally on purpose: a wrapper that drifts to any
// other wire name than ViewChannel.HostToolbarGetHeight silently replays nothing.
const GET_HEIGHT_CHANNEL = 'view:host-toolbar:get-height'

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
  transport.sendSync.mockClear()
  transport.invoke.mockImplementation(() => Promise.resolve<unknown>(undefined))
  transport.invokeStrict.mockImplementation(() => Promise.resolve<unknown>(undefined))
})

/** Structural lookup of the FUTURE export (see header). */
function readWrapper(): () => Promise<number | undefined> {
  const fn = (viewApi as Record<string, unknown>).getHostToolbarHeight
  expect(
    typeof fn,
    'view-api.ts must export getHostToolbarHeight(): Promise<number | undefined> — the mount-time replay pull for the host-toolbar placeholder',
  ).toBe('function')
  return fn as () => Promise<number | undefined>
}

describe('view-api: getHostToolbarHeight wrapper', () => {
  it('invokes the view:host-toolbar:get-height wire channel (no extra payload)', async () => {
    const getHostToolbarHeight = readWrapper()

    await getHostToolbarHeight()

    const calls = allInvokeCalls().filter(([channel]) => channel === GET_HEIGHT_CHANNEL)
    expect(
      calls.length,
      `expected exactly one invoke on ${GET_HEIGHT_CHANNEL}, saw invoke calls: ${JSON.stringify(allInvokeCalls())}`,
    ).toBe(1)
    // Pull-only channel: nothing to send along.
    expect(calls[0]!.slice(1)).toEqual([])
    // It must be an invoke round trip, not fire-and-forget.
    expect(transport.send).not.toHaveBeenCalled()
    expect(transport.sendSync).not.toHaveBeenCalled()
  })

  it('resolves to the main-side retained height verbatim', async () => {
    transport.invoke.mockImplementation((channel: string) =>
      Promise.resolve<unknown>(channel === GET_HEIGHT_CHANNEL ? 64 : undefined))
    transport.invokeStrict.mockImplementation((channel: string) =>
      Promise.resolve<unknown>(channel === GET_HEIGHT_CHANNEL ? 64 : undefined))
    const getHostToolbarHeight = readWrapper()

    await expect(getHostToolbarHeight()).resolves.toBe(64)
  })
})
