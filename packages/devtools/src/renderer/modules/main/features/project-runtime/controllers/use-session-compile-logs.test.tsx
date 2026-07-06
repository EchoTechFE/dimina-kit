/**
 * useSession compile-log state contract (dmcc 日志链路).
 *
 * Pinned contract (additive to the compileEvents suite — that suite's
 * assertions are untouched):
 *
 *  - `useSession` exposes
 *    `compileLogs: Array<{ at: number; stream: 'stdout' | 'stderr'; text: string }>`
 *    fed EXCLUSIVELY by the new `onCompileLog` subscription
 *    ('project:compileLog' push). Entries append oldest-first, `at` is taken
 *    from the pushed payload (stamped in the main process), capped at 300
 *    FIFO.
 *  - STATE ISOLATION: `compileEvents` stays sourced ONLY from projectStatus
 *    and `compileLogs` ONLY from compileLog pushes — neither feed crosses into
 *    the other array. Merging happens in the VIEW layer (CompilePanel), not
 *    here.
 *  - `clearCompileEvents()` clears BOTH arrays (the panel has one 清空
 *    button driving one callback).
 *  - Switching projects (projectPath change) clears `compileLogs` like it
 *    clears `compileEvents`.
 *
 * useSession imports `onCompileLog` from '@/shared/api'. The sibling file
 * `use-session-compile-events.test.tsx` mocks '@/shared/api' and stubs
 * `onCompileLog: vi.fn(() => () => {})` in its mock factory (not its
 * assertions) so the subscription resolves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { SessionHookResult } from './use-session'

const { projectStatusListeners, compileLogListeners } = vi.hoisted(() => ({
  projectStatusListeners: [] as Array<(s: unknown) => void>,
  compileLogListeners: [] as Array<(e: unknown) => void>,
}))

function emitProjectStatus(payload: {
  status: string
  message: string
  hotReload?: boolean
}): void {
  for (const fn of [...projectStatusListeners]) fn(payload)
}

function emitCompileLog(payload: {
  at: number
  stream: 'stdout' | 'stderr'
  text: string
}): void {
  for (const fn of [...compileLogListeners]) fn(payload)
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
    onSessionRuntimeStatus: vi.fn(() => () => {}),
    onProjectStatus: vi.fn((handler: (s: unknown) => void) => {
      projectStatusListeners.push(handler)
      return () => {
        const i = projectStatusListeners.indexOf(handler)
        if (i >= 0) projectStatusListeners.splice(i, 1)
      }
    }),
    onCompileLog: vi.fn((handler: (e: unknown) => void) => {
      compileLogListeners.push(handler)
      return () => {
        const i = compileLogListeners.indexOf(handler)
        if (i >= 0) compileLogListeners.splice(i, 1)
      }
    }),
  }
})

import { useSession } from './use-session'

beforeEach(() => {
  projectStatusListeners.length = 0
  compileLogListeners.length = 0
})

/** Structural duplicate of the future `CompileLogEntry` export. */
interface CompileLogShape {
  at: number
  stream: 'stdout' | 'stderr'
  text: string
}

function readLogs(session: SessionHookResult): CompileLogShape[] {
  const logs = (session as unknown as { compileLogs?: unknown }).compileLogs
  expect(
    Array.isArray(logs),
    'useSession must expose compileLogs: CompileLogEntry[] (the dmcc per-line log fed by the project:compileLog push)',
  ).toBe(true)
  return logs as CompileLogShape[]
}

function readEvents(session: SessionHookResult): unknown[] {
  const events = (session as unknown as { compileEvents?: unknown }).compileEvents
  expect(
    Array.isArray(events),
    'useSession must expose compileEvents (wave-1 contract — required here to assert state isolation)',
  ).toBe(true)
  return events as unknown[]
}

function readClear(session: SessionHookResult): () => void {
  const clear = (session as unknown as { clearCompileEvents?: unknown }).clearCompileEvents
  expect(typeof clear, 'useSession must expose clearCompileEvents()').toBe('function')
  return clear as () => void
}

async function renderReadySession(initialPath = '/tmp/fake-project') {
  const rendered = renderHook(
    (props: { projectPath: string }) => useSession(props),
    { initialProps: { projectPath: initialPath } },
  )
  await waitFor(() => {
    expect(rendered.result.current.compileStatus.status).toBe('ready')
  })
  return rendered
}

describe('useSession: compileLogs (dmcc 日志链路)', () => {
  it('exposes an empty compileLogs array before any compileLog traffic', async () => {
    const { result } = await renderReadySession()
    expect(readLogs(result.current)).toHaveLength(0)
  })

  it('appends one entry per compileLog push, preserving the payload `at` and arrival order', async () => {
    const { result } = await renderReadySession()

    act(() => {
      emitCompileLog({ at: 1765500000001, stream: 'stdout', text: '✔ 收集配置信息' })
    })
    act(() => {
      emitCompileLog({
        at: 1765500000002,
        stream: 'stderr',
        text: '[logic] esbuild 转换失败 /tmp/p/pages/index/index.js: Transform failed with 1 error:',
      })
    })

    const logs = readLogs(result.current)
    expect(logs).toHaveLength(2)
    // Uses toMatchObject (not exact toEqual): the panel's same-`at` tie-break
    // needs useSession to stamp a shared monotonic `seq` onto every entry, so
    // entries carry that extra field. The seq contract itself is pinned by the
    // "shared monotonic seq" suite at the bottom of this file.
    expect(logs[0]).toMatchObject({ at: 1765500000001, stream: 'stdout', text: '✔ 收集配置信息' })
    expect(
      logs[1]!.at,
      '`at` must be the main-process capture timestamp from the payload, not re-stamped in the renderer',
    ).toBe(1765500000002)
    expect(logs[1]!.stream).toBe('stderr')
  })

  it('caps the log at 300 entries, dropping the OLDEST first (FIFO)', async () => {
    const { result } = await renderReadySession()

    act(() => {
      for (let i = 1; i <= 305; i++) {
        emitCompileLog({ at: i, stream: 'stdout', text: `log-${i}` })
      }
    })

    const logs = readLogs(result.current)
    expect(logs, 'compileLogs must be capped at 300 entries').toHaveLength(300)
    expect(
      logs[0]!.text,
      'overflow must evict the OLDEST entries (FIFO): after 305 pushes the head is log-6',
    ).toBe('log-6')
    expect(logs[299]!.text).toBe('log-305')
  })

  it('keeps compileLogs and compileEvents ISOLATED: a log push never creates an event', async () => {
    const { result } = await renderReadySession()

    act(() => {
      emitCompileLog({ at: 1, stream: 'stdout', text: '✔ 收集配置信息' })
    })

    expect(readLogs(result.current)).toHaveLength(1)
    expect(
      readEvents(result.current),
      'compileEvents is sourced ONLY from projectStatus (wave-1 contract) — a compileLog push must not append to it',
    ).toHaveLength(0)
  })

  it('keeps compileLogs and compileEvents ISOLATED: a projectStatus payload never creates a log', async () => {
    const { result } = await renderReadySession()

    act(() => {
      emitProjectStatus({ status: 'compiling', message: '正在编译...' })
    })

    expect(readEvents(result.current)).toHaveLength(1)
    expect(
      readLogs(result.current),
      'compileLogs is sourced ONLY from the compileLog push — projectStatus chatter must not append to it',
    ).toHaveLength(0)
  })

  it('clearCompileEvents() clears BOTH compileEvents and compileLogs', async () => {
    const { result } = await renderReadySession()

    act(() => {
      emitProjectStatus({ status: 'ready', message: '编译完成' })
      emitCompileLog({ at: 1, stream: 'stdout', text: '✔ 输出编译产物' })
    })
    expect(readEvents(result.current)).toHaveLength(1)
    expect(readLogs(result.current)).toHaveLength(1)

    act(() => {
      readClear(result.current)()
    })

    expect(readEvents(result.current)).toHaveLength(0)
    expect(
      readLogs(result.current),
      'the single 清空 action must also empty compileLogs — one button, both stores',
    ).toHaveLength(0)

    act(() => {
      emitCompileLog({ at: 2, stream: 'stderr', text: '✖ 编译页面逻辑 [FAILED: …]' })
    })
    expect(readLogs(result.current)).toHaveLength(1)
  })

  it('switching projects (projectPath change) clears compileLogs', async () => {
    const { result, rerender } = await renderReadySession('/tmp/project-a')

    act(() => {
      emitCompileLog({ at: 1, stream: 'stdout', text: 'A 项目日志' })
    })
    expect(readLogs(result.current)).toHaveLength(1)

    rerender({ projectPath: '/tmp/project-b' })

    await waitFor(() => {
      expect(
        readLogs(result.current),
        'opening a different project must clear the previous project’s compile logs',
      ).toHaveLength(0)
    })

    act(() => {
      emitCompileLog({ at: 2, stream: 'stdout', text: 'B 项目日志' })
    })
    expect(readLogs(result.current).map((l) => l.text)).toEqual(['B 项目日志'])
  })
})

/**
 * The CompilePanel's same-`at` tie-break sorts by a shared
 * monotonic `seq` (compile-panel.tsx), so useSession must stamp one: without
 * it, entries reach the panel seq-less and every same-`at` tie falls back to
 * the events-above-logs type priority that is outlawed. The "preserves the
 * payload `at`" test above uses toMatchObject (not exact toEqual) so the
 * additive `seq` field is allowed.
 *
 * Pinned here:
 *  - every compileLogs entry carries a numeric, strictly increasing `seq`;
 *  - compileEvents entries carry `seq` from the SAME global counter, so
 *    arrival order is comparable ACROSS the two arrays — exactly the
 *    information the panel's same-`at` tie-break consumes.
 * (`at` keeps coming from the payload for logs / Date.now() for events —
 * seq is an ADDITIVE arrival marker, not a replacement.)
 */
function readSeq(entry: unknown): unknown {
  return (entry as { seq?: unknown }).seq
}

describe('useSession: shared monotonic seq across compileEvents and compileLogs', () => {
  it('stamps every compileLogs entry with a strictly increasing numeric seq', async () => {
    const { result } = await renderReadySession()

    act(() => {
      emitCompileLog({ at: 1765500000001, stream: 'stdout', text: '✔ 收集配置信息' })
    })
    act(() => {
      // Same `at` on purpose — the millisecond collision is the whole reason
      // seq exists; `at` alone cannot order these two lines.
      emitCompileLog({ at: 1765500000001, stream: 'stderr', text: '✖ 编译页面逻辑 [FAILED: …]' })
    })

    const logs = readLogs(result.current)
    expect(logs).toHaveLength(2)
    const seq0 = readSeq(logs[0])
    const seq1 = readSeq(logs[1])
    expect(
      typeof seq0,
      'every compileLogs entry must carry a numeric seq — without it the panel’s same-at tie-break '
      + '(compile-panel.tsx) has nothing to sort by and silently falls back to type priority',
    ).toBe('number')
    expect(typeof seq1).toBe('number')
    expect(
      seq1 as number,
      'seq must be strictly increasing in arrival order — two same-at lines are only orderable through it',
    ).toBeGreaterThan(seq0 as number)
  })

  it('compileEvents share the SAME global counter: interleaved event/log arrivals get strictly increasing seq across BOTH arrays', async () => {
    const { result } = await renderReadySession()

    // Interleave the two feeds: event, log, event, log — arrival order spans
    // the arrays, which is precisely what a per-array counter cannot encode.
    act(() => {
      emitProjectStatus({ status: 'compiling', message: '正在编译...' })
    })
    act(() => {
      emitCompileLog({ at: 1, stream: 'stdout', text: '✔ 收集配置信息' })
    })
    act(() => {
      emitProjectStatus({ status: 'ready', message: '编译完成' })
    })
    act(() => {
      emitCompileLog({ at: 2, stream: 'stdout', text: '✔ 输出编译产物' })
    })

    const events = readEvents(result.current)
    const logs = readLogs(result.current)
    expect(events).toHaveLength(2)
    expect(logs).toHaveLength(2)

    const arrivalOrder = [events[0], logs[0], events[1], logs[1]]
    const seqs = arrivalOrder.map(readSeq)
    for (const [i, seq] of seqs.entries()) {
      expect(
        typeof seq,
        `arrival #${i} must carry a numeric seq — compileEvents and compileLogs both feed the panel's merged `
        + 'timeline, so BOTH kinds need the arrival marker',
      ).toBe('number')
    }
    for (let i = 1; i < seqs.length; i++) {
      expect(
        seqs[i] as number,
        'seq must come from ONE shared counter spanning both stores — per-array counters cannot order an '
        + 'event against a log line that collided on the same `at`, which is the exact failure mode this guards',
      ).toBeGreaterThan(seqs[i - 1] as number)
    }
  })
})
