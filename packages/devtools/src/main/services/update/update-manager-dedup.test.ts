/**
 * Contract: UpdateManager must emit `UpdateChannel.Available` AT MOST ONCE
 * per instance lifetime, regardless of how the checked version evolves
 * (X→X, X→Y, X→null→Y, etc.). The downstream UI (a downstream host shell toast) stacks
 * on every event, so the source must be a single-shot event stream.
 *
 * These tests intentionally do NOT inspect the implementation; they only
 * drive it through the public constructor + dispose() surface that the
 * sibling `update-manager.test.ts` already uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Electron stub (hoisted so vi.mock factory can reference it) ─────────
const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const ipcHandlers = new Map<string, Handler>()
  const ipcMainStub = {
    handle: vi.fn((channel: string, fn: Handler) => {
      ipcHandlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel)
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  const appStub = {
    getVersion: vi.fn(() => '1.0.0'),
    quit: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  const shellStub = { openPath: vi.fn(async () => '') }
  return { ipcHandlers, ipcMainStub, appStub, shellStub }
})

const { ipcHandlers, ipcMainStub } = stub

vi.mock('electron', () => ({
  app: stub.appStub,
  ipcMain: stub.ipcMainStub,
  shell: stub.shellStub,
  BrowserWindow: class {},
  webContents: { getAllWebContents: () => [] },
  nativeImage: { createFromPath: () => ({}) },
}))

import type { UpdateChecker, UpdateInfo } from '../../../shared/types.js'
import { UpdateManager } from './update-manager.js'

const INITIAL_DELAY = 1_000
const CHECK_INTERVAL = 10_000

function makePanelDeps() {
  return { showUpdatePanel: vi.fn(), notifyDownloadProgress: vi.fn(), hideUpdatePanel: vi.fn() }
}

function info(version: string): UpdateInfo {
  return { version, downloadUrl: `https://example.com/${version}.dmg` }
}

/**
 * Returns a checker whose `checkForUpdates` walks through `responses`
 * one entry per call. Once exhausted, it repeats the last entry forever
 * (so callers can drive arbitrarily many extra ticks without re-setup).
 */
function makeSequencedChecker(responses: Array<UpdateInfo | null>): UpdateChecker {
  let i = 0
  return {
    checkForUpdates: vi.fn(async () => {
      const r = responses[Math.min(i, responses.length - 1)]
      i++
      return r
    }),
    downloadUpdate: vi.fn(async () => '/tmp/fake.dmg'),
  }
}

/** Every `showUpdatePanel(info)` invocation, one array entry per call. */
function availableCalls(deps: ReturnType<typeof makePanelDeps>): UpdateInfo[][] {
  return deps.showUpdatePanel.mock.calls as UpdateInfo[][]
}

/**
 * Run one check tick (initial or subsequent) and flush the async work
 * spawned inside the timer callback so `showUpdatePanel` settles.
 */
async function runTick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  // checkAndNotify is async; flush a few microtasks to make sure the
  // post-await send() has happened.
  for (let k = 0; k < 5; k++) await Promise.resolve()
}

beforeEach(() => {
  ipcHandlers.clear()
  ipcMainStub.handle.mockClear()
  ipcMainStub.removeHandler.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('UpdateManager Available-channel dedup contract', () => {
  it('first detection of version X sends UpdateChannel.Available exactly once', async () => {
    const deps = makePanelDeps()
    const x = info('2.0.0')
    const checker = makeSequencedChecker([x])

    const m = new UpdateManager({
      checker,
      ...deps,
      checkInterval: CHECK_INTERVAL,
      initialDelay: INITIAL_DELAY,
    })

    await runTick(INITIAL_DELAY)

    const calls = availableCalls(deps)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([x])

    await m.dispose()
  })

  it('does not re-send Available on subsequent ticks while version stays X', async () => {
    const deps = makePanelDeps()
    const x = info('2.0.0')
    // Every check returns the same X.
    const checker = makeSequencedChecker([x])

    const m = new UpdateManager({
      checker,
      ...deps,
      checkInterval: CHECK_INTERVAL,
      initialDelay: INITIAL_DELAY,
    })

    await runTick(INITIAL_DELAY)
    expect(availableCalls(deps)).toHaveLength(1)

    // Three more periodic ticks, same X each time.
    await runTick(CHECK_INTERVAL)
    await runTick(CHECK_INTERVAL)
    await runTick(CHECK_INTERVAL)

    // The checker did get called every tick…
    expect(checker.checkForUpdates).toHaveBeenCalledTimes(4)
    // …but Available was only announced once.
    expect(availableCalls(deps)).toHaveLength(1)

    await m.dispose()
  })

  it('does not re-send Available even when the version changes (X → Y); session is single-shot', async () => {
    const deps = makePanelDeps()
    const x = info('2.0.0')
    const y = info('2.1.0')
    const checker = makeSequencedChecker([x, x, y, y])

    const m = new UpdateManager({
      checker,
      ...deps,
      checkInterval: CHECK_INTERVAL,
      initialDelay: INITIAL_DELAY,
    })

    await runTick(INITIAL_DELAY) // -> x  (send #1, the only one)
    await runTick(CHECK_INTERVAL) // -> x  (no send)
    await runTick(CHECK_INTERVAL) // -> y  (must NOT send — instance already announced)
    await runTick(CHECK_INTERVAL) // -> y  (no send)

    const calls = availableCalls(deps)
    // Total Available count across the whole session is exactly 1, and it's X.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([x])

    await m.dispose()
  })

  it('after the single initial send, no further Available events fire regardless of subsequent checker outputs (X, null, Y, X again)', async () => {
    const deps = makePanelDeps()
    const x = info('2.0.0')
    const y = info('2.1.0')
    // First positive result sends; everything after — null, a different
    // version Y, the original X coming back — must stay silent.
    const checker = makeSequencedChecker([x, null, y, x, y, null])

    const m = new UpdateManager({
      checker,
      ...deps,
      checkInterval: CHECK_INTERVAL,
      initialDelay: INITIAL_DELAY,
    })

    await runTick(INITIAL_DELAY) // x     (send #1)
    await runTick(CHECK_INTERVAL) // null
    await runTick(CHECK_INTERVAL) // y     (must NOT send)
    await runTick(CHECK_INTERVAL) // x
    await runTick(CHECK_INTERVAL) // y
    await runTick(CHECK_INTERVAL) // null

    // Total Available calls across the whole session: exactly 1.
    expect(availableCalls(deps)).toHaveLength(1)
    expect(availableCalls(deps)[0]).toEqual([x])

    await m.dispose()
  })

  it('dispose + reconstruct resets the already-notified version set', async () => {
    const deps1 = makePanelDeps()
    const x = info('2.0.0')
    const m1 = new UpdateManager({
      checker: makeSequencedChecker([x]),
      ...deps1,
      checkInterval: CHECK_INTERVAL,
      initialDelay: INITIAL_DELAY,
    })
    await runTick(INITIAL_DELAY)
    expect(availableCalls(deps1)).toHaveLength(1)
    await m1.dispose()

    // Fresh instance, fresh deps, same X — must announce again because
    // dedup state lives on the instance, not globally.
    const deps2 = makePanelDeps()
    const m2 = new UpdateManager({
      checker: makeSequencedChecker([x]),
      ...deps2,
      checkInterval: CHECK_INTERVAL,
      initialDelay: INITIAL_DELAY,
    })
    await runTick(INITIAL_DELAY)
    expect(availableCalls(deps2)).toHaveLength(1)
    expect(availableCalls(deps2)[0]).toEqual([x])
    await m2.dispose()
  })
})
