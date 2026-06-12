/**
 * 编译信息 tab — data source contract (TDD, NOT yet implemented).
 *
 * `useSession` already subscribes to every `projectStatus` payload (it feeds
 * `compileStatus` + the PR#43 `hotReloadToken`). This suite pins the NEW
 * compile-event log built on that same subscription:
 *
 *  - `useSession` exposes `compileEvents: CompileEvent[]` and
 *    `clearCompileEvents(): void`.
 *  - Every `projectStatus` payload appends one event
 *    `{ at: number (Date.now), status, message, hotReload? }` to the END of
 *    the array (chronological order, oldest first — the panel reverses for
 *    display).
 *  - The log is capped at 200 entries, FIFO (oldest dropped first).
 *  - `clearCompileEvents()` empties the log; later events accumulate again.
 *  - Switching projects (the `projectPath`-keyed openProject reset point)
 *    clears the log — each project gets an independent log.
 *
 * Today `useSession` returns no `compileEvents`, so every test here is red.
 * Implementation note: export the `CompileEvent` interface from
 * `use-session.ts` so consumers (controller slice, CompilePanel props) can
 * import it — this file deliberately duplicates the shape structurally
 * because the export does not exist yet.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { SessionHookResult } from './use-session'

// ── Module mocks ─────────────────────────────────────────────────────────
//
// Same harness as use-session-hot-reload.test.tsx: mock `@/shared/api` so the
// hook runs without a preload bridge, and capture the projectStatus listener
// so the test can play "main process sends a payload".

// vi.mock factories are hoisted above module-level consts, so the shared
// listener registry must be created via vi.hoisted to avoid a TDZ crash.
const { projectStatusListeners } = vi.hoisted(() => ({
  projectStatusListeners: [] as Array<(s: unknown) => void>,
}))

function emitProjectStatus(payload: {
  status: string
  message: string
  hotReload?: boolean
}): void {
  for (const fn of [...projectStatusListeners]) fn(payload)
}

vi.mock('@/shared/api', () => {
  return {
    openProject: vi.fn(async () => ({
      success: true,
      appInfo: { appId: 'fake-app' },
      port: 12345,
    })),
    getProjectPages: vi.fn(async () => ({
      pages: ['pages/index/index'],
      entryPagePath: 'pages/index/index',
    })),
    getCompileConfig: vi.fn(async () => ({
      startPage: 'pages/index/index',
      scene: 1011,
      queryParams: [],
    })),
    saveCompileConfig: vi.fn(async () => {}),
    onProjectStatus: vi.fn((handler: (s: unknown) => void) => {
      projectStatusListeners.push(handler)
      return () => {
        const i = projectStatusListeners.indexOf(handler)
        if (i >= 0) projectStatusListeners.splice(i, 1)
      }
    }),
    // Harness stub (pre-authorized ROUND 2 fix): useSession now also
    // subscribes onCompileLog; this suite asserts nothing about it.
    onCompileLog: vi.fn(() => () => {}),
  }
})

import { useSession } from './use-session'

beforeEach(() => {
  projectStatusListeners.length = 0
})

/** Structural duplicate of the future `CompileEvent` export (see header). */
interface CompileEventShape {
  at: number
  status: string
  message: string
  hotReload?: boolean
}

/**
 * Read the (future) `compileEvents` off the session result. Structural lookup
 * so this file compiles before the implementation lands; the runtime
 * assertion is what goes red.
 */
function readEvents(session: SessionHookResult): CompileEventShape[] {
  const events = (session as unknown as { compileEvents?: unknown }).compileEvents
  expect(
    Array.isArray(events),
    'useSession must expose compileEvents: CompileEvent[] (the 编译 tab’s event log)',
  ).toBe(true)
  return events as CompileEventShape[]
}

function readClear(session: SessionHookResult): () => void {
  const clear = (session as unknown as { clearCompileEvents?: unknown }).clearCompileEvents
  expect(
    typeof clear,
    'useSession must expose clearCompileEvents(): void (the 编译 tab’s 清空 action)',
  ).toBe('function')
  return clear as () => void
}

async function renderReadySession(initialPath = '/tmp/fake-project') {
  const rendered = renderHook(
    (props: { projectPath: string }) => useSession(props),
    { initialProps: { projectPath: initialPath } },
  )
  // Wait for the async openProject → ready flow so later status emissions are
  // unambiguously projectStatus-driven, not initial-load races.
  await waitFor(() => {
    expect(rendered.result.current.compileStatus.status).toBe('ready')
  })
  return rendered
}

describe('useSession: compileEvents log (编译 tab data source)', () => {
  it('exposes an empty compileEvents array + clearCompileEvents() before any projectStatus traffic', async () => {
    const { result } = await renderReadySession()
    // The initial openProject load sets compileStatus locally WITHOUT a
    // projectStatus emission — it must NOT synthesize log entries: the log's
    // single source is the projectStatus subscription.
    expect(readEvents(result.current)).toHaveLength(0)
    readClear(result.current)
  })

  it('appends one event per projectStatus payload with {at: Date.now, status, message}', async () => {
    const { result } = await renderReadySession()

    const before = Date.now()
    act(() => {
      emitProjectStatus({ status: 'compiling', message: '正在编译...' })
    })
    const after = Date.now()

    const events = readEvents(result.current)
    expect(events).toHaveLength(1)
    expect(events[0]!.status).toBe('compiling')
    expect(events[0]!.message).toBe('正在编译...')
    expect(
      events[0]!.at,
      'at must be the wall-clock capture time (Date.now) of the event',
    ).toBeGreaterThanOrEqual(before)
    expect(events[0]!.at).toBeLessThanOrEqual(after)
  })

  it('appends in arrival order (oldest first — index 0 is the earliest event)', async () => {
    const { result } = await renderReadySession()

    act(() => {
      emitProjectStatus({ status: 'compiling', message: '第一条' })
    })
    act(() => {
      emitProjectStatus({ status: 'ready', message: '第二条' })
    })

    const events = readEvents(result.current)
    expect(events.map((e) => e.message)).toEqual(['第一条', '第二条'])
  })

  it('carries hotReload through: true for watcher rebuilds, not-true for plain chatter', async () => {
    const { result } = await renderReadySession()

    act(() => {
      emitProjectStatus({ status: 'ready', message: '编译完成，已热更新', hotReload: true })
    })
    act(() => {
      emitProjectStatus({ status: 'ready', message: '编译完成' })
    })
    act(() => {
      emitProjectStatus({ status: 'ready', message: '编译完成（显式 false）', hotReload: false })
    })

    const events = readEvents(result.current)
    expect(events).toHaveLength(3)
    expect(
      events[0]!.hotReload,
      'a watcher-rebuild payload (hotReload:true) must be marked on its log entry — the panel renders the 热更新 chip off this flag',
    ).toBe(true)
    expect(events[1]!.hotReload).not.toBe(true)
    expect(events[2]!.hotReload).not.toBe(true)
  })

  it('caps the log at 200 entries, dropping the OLDEST first (FIFO)', async () => {
    const { result } = await renderReadySession()

    act(() => {
      for (let i = 1; i <= 205; i++) {
        emitProjectStatus({ status: 'ready', message: `msg-${i}` })
      }
    })

    const events = readEvents(result.current)
    expect(events, 'log must be capped at 200 entries').toHaveLength(200)
    expect(
      events[0]!.message,
      'overflow must evict the OLDEST entries (FIFO): after 205 emissions the head is msg-6',
    ).toBe('msg-6')
    expect(events[199]!.message).toBe('msg-205')
  })

  it('clearCompileEvents() empties the log and later events accumulate again', async () => {
    const { result } = await renderReadySession()

    act(() => {
      emitProjectStatus({ status: 'compiling', message: 'a' })
      emitProjectStatus({ status: 'ready', message: 'b' })
    })
    expect(readEvents(result.current)).toHaveLength(2)

    act(() => {
      readClear(result.current)()
    })
    expect(readEvents(result.current)).toHaveLength(0)

    act(() => {
      emitProjectStatus({ status: 'ready', message: '清空后的新事件' })
    })
    const events = readEvents(result.current)
    expect(events).toHaveLength(1)
    expect(events[0]!.message).toBe('清空后的新事件')
  })

  it('switching projects (projectPath change) clears the log — per-project logs are independent', async () => {
    const { result, rerender } = await renderReadySession('/tmp/project-a')

    act(() => {
      emitProjectStatus({ status: 'compiling', message: 'A 项目事件 1' })
      emitProjectStatus({ status: 'ready', message: 'A 项目事件 2' })
    })
    expect(readEvents(result.current)).toHaveLength(2)

    rerender({ projectPath: '/tmp/project-b' })

    // The reset is keyed off the projectPath-driven openProject effect — be
    // tolerant of whether it lands synchronously with the effect or with the
    // (mocked, fast) load completion.
    await waitFor(() => {
      expect(
        readEvents(result.current),
        'opening a different project must clear the previous project’s log',
      ).toHaveLength(0)
    })

    act(() => {
      emitProjectStatus({ status: 'ready', message: 'B 项目事件' })
    })
    const events = readEvents(result.current)
    expect(events.map((e) => e.message)).toEqual(['B 项目事件'])
  })
})

/**
 * CODEX RE-REVIEW — m8 NOT-RESOLVED follow-up (CONTRACT EVOLUTION,
 * pre-authorized). The CompilePanel breaks same-`at` ties by a monotonic
 * `seq` (compile-panel.tsx, already pinned), but useSession never stamps it
 * on compileEvents. Pinned here: every event carries a strictly increasing
 * numeric `seq`. The CROSS-array half of the contract (events and logs share
 * ONE global counter) is pinned in use-session-compile-logs.test.tsx, whose
 * harness can emit both feeds — this suite's onCompileLog mock is a no-op
 * stub by design.
 */
describe('useSession: compileEvents carry a monotonic seq (codex m8 contract evolution)', () => {
  it('stamps every compileEvents entry with a strictly increasing numeric seq', async () => {
    const { result } = await renderReadySession()

    act(() => {
      emitProjectStatus({ status: 'compiling', message: '正在编译...' })
    })
    act(() => {
      emitProjectStatus({ status: 'ready', message: '编译完成' })
    })

    const events = readEvents(result.current)
    expect(events).toHaveLength(2)
    const seq0 = (events[0] as { seq?: unknown }).seq
    const seq1 = (events[1] as { seq?: unknown }).seq
    expect(
      typeof seq0,
      'every compileEvents entry must carry a numeric seq — `at` is a millisecond stamp, so an event and the '
      + 'log lines of the same compile routinely collide on it; seq is the panel’s only tie-break carrier',
    ).toBe('number')
    expect(typeof seq1).toBe('number')
    expect(
      seq1 as number,
      'seq must be strictly increasing in arrival order',
    ).toBeGreaterThan(seq0 as number)
  })
})
