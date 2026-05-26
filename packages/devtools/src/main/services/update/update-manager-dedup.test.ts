/**
 * Contract: UpdateManager must emit `UpdateChannel.Available` AT MOST ONCE
 * per instance lifetime, regardless of how the checked version evolves
 * (X→X, X→Y, X→null→Y, etc.). The downstream UI (qdmp shell toast) stacks
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
import { UpdateChannel } from '../../../shared/ipc-channels.js'
import { UpdateManager } from './update-manager.js'

const INITIAL_DELAY = 1_000
const CHECK_INTERVAL = 10_000

function makeMainWindow() {
  return {
    webContents: { send: vi.fn(), isDestroyed: () => false },
  } as unknown as Electron.BrowserWindow & {
    webContents: { send: ReturnType<typeof vi.fn> }
  }
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

/** Get every `webContents.send` call targeting UpdateChannel.Available. */
function availableCalls(
  mw: ReturnType<typeof makeMainWindow>,
): unknown[][] {
  return mw.webContents.send.mock.calls.filter(
    (c: unknown[]) => c[0] === UpdateChannel.Available,
  )
}

/**
 * Run one check tick (initial or subsequent) and flush the async work
 * spawned inside the timer callback so `webContents.send` settles.
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
    const mw = makeMainWindow()
    const x = info('2.0.0')
    const checker = makeSequencedChecker([x])

    const m = new UpdateManager({
      checker,
      mainWindow: mw,
      checkInterval: CHECK_INTERVAL,
      initialDelay: INITIAL_DELAY,
    })

    await runTick(INITIAL_DELAY)

    const calls = availableCalls(mw)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([UpdateChannel.Available, x])

    await m.dispose()
  })

  it('does not re-send Available on subsequent ticks while version stays X', async () => {
    const mw = makeMainWindow()
    const x = info('2.0.0')
    // Every check returns the same X.
    const checker = makeSequencedChecker([x])

    const m = new UpdateManager({
      checker,
      mainWindow: mw,
      checkInterval: CHECK_INTERVAL,
      initialDelay: INITIAL_DELAY,
    })

    await runTick(INITIAL_DELAY)
    expect(availableCalls(mw)).toHaveLength(1)

    // Three more periodic ticks, same X each time.
    await runTick(CHECK_INTERVAL)
    await runTick(CHECK_INTERVAL)
    await runTick(CHECK_INTERVAL)

    // The checker did get called every tick…
    expect(checker.checkForUpdates).toHaveBeenCalledTimes(4)
    // …but Available was only announced once.
    expect(availableCalls(mw)).toHaveLength(1)

    await m.dispose()
  })

  it('does not re-send Available even when the version changes (X → Y); session is single-shot', async () => {
    const mw = makeMainWindow()
    const x = info('2.0.0')
    const y = info('2.1.0')
    const checker = makeSequencedChecker([x, x, y, y])

    const m = new UpdateManager({
      checker,
      mainWindow: mw,
      checkInterval: CHECK_INTERVAL,
      initialDelay: INITIAL_DELAY,
    })

    await runTick(INITIAL_DELAY) // -> x  (send #1, the only one)
    await runTick(CHECK_INTERVAL) // -> x  (no send)
    await runTick(CHECK_INTERVAL) // -> y  (must NOT send — instance already announced)
    await runTick(CHECK_INTERVAL) // -> y  (no send)

    const calls = availableCalls(mw)
    // Total Available count across the whole session is exactly 1, and it's X.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([UpdateChannel.Available, x])

    await m.dispose()
  })

  it('after the single initial send, no further Available events fire regardless of subsequent checker outputs (X, null, Y, X again)', async () => {
    const mw = makeMainWindow()
    const x = info('2.0.0')
    const y = info('2.1.0')
    // First positive result sends; everything after — null, a different
    // version Y, the original X coming back — must stay silent.
    const checker = makeSequencedChecker([x, null, y, x, y, null])

    const m = new UpdateManager({
      checker,
      mainWindow: mw,
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
    expect(availableCalls(mw)).toHaveLength(1)
    expect(availableCalls(mw)[0]).toEqual([UpdateChannel.Available, x])

    await m.dispose()
  })

  it('dispose + reconstruct resets the already-notified version set', async () => {
    const mw1 = makeMainWindow()
    const x = info('2.0.0')
    const m1 = new UpdateManager({
      checker: makeSequencedChecker([x]),
      mainWindow: mw1,
      checkInterval: CHECK_INTERVAL,
      initialDelay: INITIAL_DELAY,
    })
    await runTick(INITIAL_DELAY)
    expect(availableCalls(mw1)).toHaveLength(1)
    await m1.dispose()

    // Fresh instance, fresh main window, same X — must announce again
    // because dedup state lives on the instance, not globally.
    const mw2 = makeMainWindow()
    const m2 = new UpdateManager({
      checker: makeSequencedChecker([x]),
      mainWindow: mw2,
      checkInterval: CHECK_INTERVAL,
      initialDelay: INITIAL_DELAY,
    })
    await runTick(INITIAL_DELAY)
    expect(availableCalls(mw2)).toHaveLength(1)
    expect(availableCalls(mw2)[0]).toEqual([UpdateChannel.Available, x])
    await m2.dispose()
  })
})
