/**
 * 编译信息 tab — CompilePanel component contract (TDD, NOT yet implemented).
 *
 * Target file: `right-panel/compile-panel.tsx`, named export `CompilePanel`,
 * props `{ events: CompileEvent[]; onClear: () => void }` where `events` is
 * the chronological (oldest-first) log from `useSession().compileEvents`.
 *
 * Pinned contract:
 *  - Empty state: no events → copy matching /暂无编译/, no rows.
 *  - Current-status badge: `[data-compile-current]` reflects the LATEST
 *    event — `data-status` attribute = its status, text contains its message.
 *  - History list: rows are `[data-compile-row]`, rendered NEWEST FIRST
 *    (reverse of the input array), each carrying `data-status` (the styling
 *    hook that makes error rows distinguishable) and an HH:MM:SS timestamp.
 *  - hotReload events render a recognizable 热更新 chip; plain events don't.
 *  - A ready event immediately preceded by a compiling event shows the
 *    elapsed time in `[data-compile-duration]` (e.g. 2.2s); unpaired ready
 *    events (first event, or previous event isn't compiling) show none.
 *  - The 清空 button calls `onClear`.
 *
 * The module is loaded via `import.meta.glob` so this file typechecks and
 * lints while the component does not exist yet — the glob simply matches
 * nothing and the load helper goes red with an explicit message.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ComponentType } from 'react'
import { render, fireEvent } from '@testing-library/react'

/** Structural duplicate of the future `CompileEvent` export from use-session. */
interface CompileEvent {
  at: number
  status: string
  message: string
  hotReload?: boolean
}

interface CompilePanelProps {
  events: CompileEvent[]
  onClear: () => void
}

// Static-import-free loading: the glob matches zero modules until
// compile-panel.tsx exists, keeping tsc/eslint green in the red phase.
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

async function renderPanel(events: CompileEvent[], onClear = vi.fn()) {
  const CompilePanel = await loadCompilePanel()
  const utils = render(<CompilePanel events={events} onClear={onClear} />)
  return { ...utils, onClear }
}

function rowsOf(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-compile-row]'))
}

describe('CompilePanel (编译 tab body)', () => {
  it('renders an empty state (暂无编译…) and no rows when there are no events', async () => {
    const { container } = await renderPanel([])
    expect(
      container.textContent,
      'with no events the panel must show an empty-state copy instead of a blank area',
    ).toMatch(/暂无编译/)
    expect(rowsOf(container)).toHaveLength(0)
  })

  it('shows a current-status badge for the LATEST event (status attribute + message text)', async () => {
    const { container } = await renderPanel([
      { at: at(9, 0, 0), status: 'compiling', message: '正在编译...' },
      { at: at(9, 0, 2), status: 'ready', message: '编译完成（最新）' },
    ])

    const badge = container.querySelector<HTMLElement>('[data-compile-current]')
    expect(
      badge,
      'the panel header must carry a [data-compile-current] badge reflecting the most recent event',
    ).not.toBeNull()
    expect(
      badge!.getAttribute('data-status'),
      'the badge must expose the latest status via data-status (the assertable styling hook)',
    ).toBe('ready')
    expect(badge!.textContent).toContain('编译完成（最新）')
  })

  it('lists history NEWEST FIRST with an HH:MM:SS timestamp and the message on each row', async () => {
    const { container } = await renderPanel([
      { at: at(9, 5, 7), status: 'compiling', message: '第一条' },
      { at: at(9, 5, 9), status: 'ready', message: '第二条' },
    ])

    const rows = rowsOf(container)
    expect(rows).toHaveLength(2)
    expect(
      rows[0]!.textContent,
      'rows must be reverse-chronological: the newest event is the first row',
    ).toContain('第二条')
    expect(rows[0]!.textContent).toMatch(/09:05:09/)
    expect(rows[1]!.textContent).toContain('第一条')
    expect(rows[1]!.textContent).toMatch(/09:05:07/)
  })

  it('marks error rows distinguishably via data-status="error"', async () => {
    const { container } = await renderPanel([
      { at: at(10, 0, 0), status: 'ready', message: '编译完成' },
      { at: at(10, 0, 5), status: 'error', message: '编译失败: syntax error' },
    ])

    const rows = rowsOf(container)
    expect(rows).toHaveLength(2)
    // Newest first → the error event is row 0.
    expect(
      rows[0]!.getAttribute('data-status'),
      'error rows must carry data-status="error" so they can be styled (and asserted) distinctly',
    ).toBe('error')
    expect(rows[1]!.getAttribute('data-status')).toBe('ready')
  })

  it('renders a 热更新 chip on hotReload events only', async () => {
    const { container } = await renderPanel([
      { at: at(11, 0, 0), status: 'ready', message: '普通编译完成' },
      { at: at(11, 0, 5), status: 'ready', message: '编译完成，已热更新', hotReload: true },
    ])

    const rows = rowsOf(container)
    expect(rows).toHaveLength(2)
    expect(
      rows[0]!.textContent,
      'a hotReload event must carry a recognizable 热更新 marker',
    ).toMatch(/热更新/)
    expect(
      rows[1]!.textContent,
      'plain events must NOT carry the 热更新 marker',
    ).not.toMatch(/热更新/)
  })

  it('shows the elapsed time on a ready event paired with the immediately preceding compiling event', async () => {
    const t0 = at(12, 0, 0)
    const { container } = await renderPanel([
      { at: t0, status: 'compiling', message: '正在编译...' },
      { at: t0 + 2200, status: 'ready', message: '编译完成' },
    ])

    const rows = rowsOf(container)
    const duration = rows[0]!.querySelector<HTMLElement>('[data-compile-duration]')
    expect(
      duration,
      'a ready row paired with the previous compiling row must show the elapsed time in [data-compile-duration]',
    ).not.toBeNull()
    expect(duration!.textContent).toMatch(/2\.2\s*s/)
  })

  it('shows NO duration when the ready event cannot be paired with a preceding compiling event', async () => {
    // Case 1: ready is the very first event (nothing to pair with).
    const first = await renderPanel([
      { at: at(13, 0, 0), status: 'ready', message: '编译完成' },
    ])
    expect(first.container.querySelector('[data-compile-duration]')).toBeNull()
    first.unmount()

    // Case 2: the immediately previous event is not compiling.
    const second = await renderPanel([
      { at: at(13, 1, 0), status: 'compiling', message: '正在编译...' },
      { at: at(13, 1, 2), status: 'error', message: '编译失败' },
      { at: at(13, 1, 9), status: 'ready', message: '编译完成' },
    ])
    expect(
      second.container.querySelector('[data-compile-duration]'),
      'pairing is strictly with the IMMEDIATELY preceding event — an intervening error breaks the pair',
    ).toBeNull()
  })

  it('the 清空 button calls onClear', async () => {
    const { getByRole, onClear } = await renderPanel([
      { at: at(14, 0, 0), status: 'ready', message: '编译完成' },
    ])

    fireEvent.click(getByRole('button', { name: '清空' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
