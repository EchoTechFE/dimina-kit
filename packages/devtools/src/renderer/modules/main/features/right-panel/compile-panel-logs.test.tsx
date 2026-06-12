/**
 * ROUND 2 (dmcc 日志链路) — CompilePanel `logs` prop contract
 * (TDD, NOT yet implemented). Additive to the wave-1 compile-panel suite —
 * its `{ events, onClear }` assertions are untouched.
 *
 * Pinned contract:
 *  - `CompilePanel` gains an OPTIONAL `logs?: CompileLogEntry[]` prop
 *    (`{ at: number; stream: 'stdout' | 'stderr'; text: string }`,
 *    oldest-first like `events`). Optional + default empty, so every wave-1
 *    render without `logs` keeps its exact behaviour (incl. the 暂无编译
 *    empty state).
 *  - Log lines render as part of ONE timeline merged with events by `at`
 *    (newest first, matching the wave-1 row order). Merging is a VIEW
 *    concern — state stays isolated in useSession.
 *  - Log rows are identifiable: `[data-compile-log]` carrying
 *    `data-stream="stdout" | "stderr"` (the styling hook that makes stderr
 *    lines distinguishable), the line text, and an HH:MM:SS timestamp like
 *    event rows.
 *  - The `[data-compile-current]` badge stays EVENT-driven: a newer log line
 *    must not hijack the latest-status badge.
 *  - Logs alone (no events) suppress the 暂无编译 empty state.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ComponentType } from 'react'
import { render } from '@testing-library/react'

interface CompileEvent {
  at: number
  status: string
  message: string
  hotReload?: boolean
  /** Shared monotonic arrival counter across events AND logs (codex m8). */
  seq?: number
}

interface CompileLogEntry {
  at: number
  stream: 'stdout' | 'stderr'
  text: string
  /** Shared monotonic arrival counter across events AND logs (codex m8). */
  seq?: number
}

interface CompilePanelProps {
  events: CompileEvent[]
  logs?: CompileLogEntry[]
  onClear: () => void
}

// Same red-phase loading dodge as the wave-1 suite: the glob matches zero
// modules until compile-panel.tsx exists.
const compilePanelModules = import.meta.glob('./compile-panel.tsx')

async function loadCompilePanel(): Promise<ComponentType<CompilePanelProps>> {
  const loader = compilePanelModules['./compile-panel.tsx']
  expect(
    loader,
    'right-panel/compile-panel.tsx does not exist yet — create it with a named CompilePanel export (TDD red)',
  ).toBeTruthy()
  const mod = (await loader!()) as { CompilePanel?: ComponentType<CompilePanelProps> }
  expect(
    mod.CompilePanel,
    'compile-panel.tsx must have a named export `CompilePanel`',
  ).toBeTruthy()
  return mod.CompilePanel!
}

/** Local-time timestamp helper — HH:MM:SS assertions stay timezone-proof. */
function at(h: number, m: number, s: number): number {
  return new Date(2026, 5, 12, h, m, s).getTime()
}

async function renderPanel(
  events: CompileEvent[],
  logs: CompileLogEntry[],
  onClear = vi.fn(),
) {
  const CompilePanel = await loadCompilePanel()
  const utils = render(<CompilePanel events={events} logs={logs} onClear={onClear} />)
  return { ...utils, onClear }
}

function logRowsOf(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-compile-log]'))
}

function timelineTextsOf(container: HTMLElement): string[] {
  // DOM order across BOTH row kinds = the rendered timeline order.
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-compile-row], [data-compile-log]'),
  ).map((el) => el.textContent ?? '')
}

describe('CompilePanel: logs prop (ROUND 2 — dmcc 日志链路)', () => {
  it('renders log lines as [data-compile-log] rows with the line text', async () => {
    const { container } = await renderPanel(
      [],
      [
        { at: at(9, 0, 0), stream: 'stdout', text: '✔ 收集配置信息' },
        { at: at(9, 0, 1), stream: 'stdout', text: '✔ 输出编译产物' },
      ],
    )

    const rows = logRowsOf(container)
    expect(
      rows,
      'each log entry must render a [data-compile-log] row — the assertable marker that distinguishes log lines from event rows',
    ).toHaveLength(2)
    const texts = rows.map((r) => r.textContent ?? '')
    expect(texts.some((t) => t.includes('✔ 收集配置信息'))).toBe(true)
    expect(texts.some((t) => t.includes('✔ 输出编译产物'))).toBe(true)
  })

  it('tags every log row with data-stream so stderr lines are distinguishable', async () => {
    const { container } = await renderPanel(
      [],
      [
        { at: at(9, 1, 0), stream: 'stdout', text: '✔ 编译页面逻辑' },
        {
          at: at(9, 1, 5),
          stream: 'stderr',
          text: '[logic] esbuild 转换失败 /tmp/p/pages/index/index.js: Transform failed with 1 error:',
        },
      ],
    )

    const rows = logRowsOf(container)
    expect(rows).toHaveLength(2)
    const byText = (needle: string) =>
      rows.find((r) => (r.textContent ?? '').includes(needle))
    expect(
      byText('✔ 编译页面逻辑')!.getAttribute('data-stream'),
      'stdout lines must carry data-stream="stdout"',
    ).toBe('stdout')
    expect(
      byText('esbuild 转换失败')!.getAttribute('data-stream'),
      'stderr lines must carry data-stream="stderr" — the styling hook for error-ish lines',
    ).toBe('stderr')
  })

  it('merges events and logs into ONE timeline ordered by `at`, newest first', async () => {
    const { container } = await renderPanel(
      [
        { at: at(10, 0, 0), status: 'compiling', message: '事件一' },
        { at: at(10, 0, 4), status: 'ready', message: '事件二' },
      ],
      [
        { at: at(10, 0, 2), stream: 'stdout', text: '日志一' },
        { at: at(10, 0, 6), stream: 'stdout', text: '日志二' },
      ],
    )

    const texts = timelineTextsOf(container)
    expect(
      texts,
      'events ([data-compile-row]) and logs ([data-compile-log]) must interleave in one timeline',
    ).toHaveLength(4)
    const indexOf = (needle: string) => texts.findIndex((t) => t.includes(needle))
    expect(indexOf('日志二')).toBe(0)
    expect(indexOf('事件二')).toBe(1)
    expect(indexOf('日志一')).toBe(2)
    expect(indexOf('事件一')).toBe(3)
  })

  it('shows an HH:MM:SS timestamp on log rows (same format as event rows)', async () => {
    const { container } = await renderPanel(
      [],
      [{ at: at(11, 5, 9), stream: 'stdout', text: '✔ 输出编译产物' }],
    )

    const row = logRowsOf(container)[0]!
    expect(row.textContent).toMatch(/11:05:09/)
  })

  it('keeps the [data-compile-current] badge EVENT-driven even when a log line is newer', async () => {
    const { container } = await renderPanel(
      [{ at: at(12, 0, 0), status: 'ready', message: '编译完成（最新事件）' }],
      [{ at: at(12, 0, 30), stream: 'stderr', text: '[compat] Unsupported wx API: wx.switchTab (/pages/tabbar-me/tabbar-me.js:7)' }],
    )

    const badge = container.querySelector<HTMLElement>('[data-compile-current]')
    expect(badge, 'the current-status badge must still render').not.toBeNull()
    expect(
      badge!.getAttribute('data-status'),
      'the badge reflects the latest EVENT — log chatter must not hijack the compile status',
    ).toBe('ready')
    expect(badge!.textContent).toContain('编译完成（最新事件）')
  })

  it('suppresses the 暂无编译 empty state when there are logs but no events', async () => {
    const { container } = await renderPanel(
      [],
      [{ at: at(13, 0, 0), stream: 'stdout', text: '✔ 收集配置信息' }],
    )

    expect(
      container.textContent,
      'a non-empty log means the panel has content — the empty-state copy must not show',
    ).not.toMatch(/暂无编译/)
    expect(logRowsOf(container)).toHaveLength(1)
  })

  it('still shows the empty state when both events and logs are empty', async () => {
    const { container } = await renderPanel([], [])
    expect(container.textContent).toMatch(/暂无编译/)
    expect(logRowsOf(container)).toHaveLength(0)
    expect(container.querySelectorAll('[data-compile-row]')).toHaveLength(0)
  })
})

/**
 * CODEX-REVIEW REGRESSION (m8) — `at` is a Date.now() millisecond stamp, so a
 * status event and the log lines of the same compile routinely COLLIDE on the
 * same `at`. The current merge pushes ALL events first, then ALL logs, then
 * stable-sorts by `at` — so within a same-`at` tie, events always rank above
 * logs no matter which actually arrived first. The pin: ties keep ARRIVAL
 * order (the suggested carrier is a shared monotonic `seq` across both
 * stores; any equivalent arrival marker works — only the rendered order is
 * pinned). Across different `at` values the newest-first order is untouched.
 */
describe('CompilePanel: same-at ties keep arrival order, not type priority (codex m8)', () => {
  const T = at(14, 30, 0)

  it('a log line that ARRIVED before a same-at event renders above it', async () => {
    const { container } = await renderPanel(
      // Arrival: log first (seq 0), event second (seq 1) — same `at`.
      [{ at: T, seq: 1, status: 'ready', message: '编译完成' }],
      [{ at: T, seq: 0, stream: 'stdout', text: '✔ 输出编译产物' }],
    )

    const texts = timelineTextsOf(container)
    expect(texts).toHaveLength(2)
    const logIndex = texts.findIndex((t) => t.includes('✔ 输出编译产物'))
    const eventIndex = texts.findIndex((t) => t.includes('编译完成'))
    expect(logIndex).toBeGreaterThanOrEqual(0)
    expect(eventIndex).toBeGreaterThanOrEqual(0)
    expect(
      logIndex,
      'same-at tie: the timeline must keep ARRIVAL order — the type-grouped concat + stable sort pins events '
      + 'above logs regardless of which actually came first, so the ready event renders above the very log '
      + 'lines that preceded it',
    ).toBeLessThan(eventIndex)
  })

  it('an event that ARRIVED before a same-at log line renders above it (arrival order, not log priority)', async () => {
    const { container } = await renderPanel(
      // Arrival: event first (seq 0), log second (seq 1) — same `at`.
      [{ at: T, seq: 0, status: 'compiling', message: '正在编译...' }],
      [{ at: T, seq: 1, stream: 'stdout', text: '✔ 收集配置信息' }],
    )

    const texts = timelineTextsOf(container)
    expect(texts).toHaveLength(2)
    const eventIndex = texts.findIndex((t) => t.includes('正在编译'))
    const logIndex = texts.findIndex((t) => t.includes('✔ 收集配置信息'))
    expect(
      eventIndex,
      'the fix must be ARRIVAL order, not a blanket "logs before events" inversion — an event that arrived '
      + 'first stays above its same-at followers',
    ).toBeLessThan(logIndex)
  })

  it('different `at` values keep the existing newest-first order regardless of seq', async () => {
    const { container } = await renderPanel(
      [{ at: at(14, 30, 5), seq: 0, status: 'ready', message: '编译完成' }],
      [{ at: at(14, 30, 1), seq: 1, stream: 'stdout', text: '✔ 收集配置信息' }],
    )

    const texts = timelineTextsOf(container)
    const eventIndex = texts.findIndex((t) => t.includes('编译完成'))
    const logIndex = texts.findIndex((t) => t.includes('✔ 收集配置信息'))
    expect(
      eventIndex,
      'the arrival tie-break must only apply WITHIN a same-at tie — across different `at` values the timeline '
      + 'stays newest-first',
    ).toBeLessThan(logIndex)
  })
})
