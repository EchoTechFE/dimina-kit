/**
 * ROUND 2 (dmcc 日志链路) — BottomDebugPanel `compileLogs` passthrough
 * contract (TDD, NOT yet implemented). Additive to the wave-1
 * bottom-debug-panel-compile-tab suite — its assertions are untouched.
 *
 * Pinned contract: BottomDebugPanel gains a `compileLogs` prop
 * (`Array<{ at: number; stream: 'stdout' | 'stderr'; text: string }>`) and
 * passes it to the CompilePanel rendered in the `[data-tab-panel="compile"]`
 * body as its `logs` prop. Pure passthrough — no transformation in the
 * debug-panel layer.
 *
 * Sibling panels are mocked to inert stubs (same harness as wave 1);
 * CompilePanel is NOT mocked, so this integrates through the real component.
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { BottomDebugPanel, type BottomDebugPanelProps } from './bottom-debug-panel'
import type { RightPaneTabId } from '../project-runtime/types'

vi.mock('../right-panel/wxml-panel.js', () => ({ WxmlPanel: () => null }))
vi.mock('../right-panel/appdata-panel.js', () => ({ AppDataPanel: () => null }))
vi.mock('../right-panel/storage-panel.js', () => ({ StoragePanel: () => null }))

interface CompileLogShape {
  at: number
  stream: 'stdout' | 'stderr'
  text: string
}

const okWrite = async () => ({ ok: true as const })

function makeBaseProps(selected: RightPaneTabId): BottomDebugPanelProps {
  return {
    rightPane: { selected, simulatorVisible: true },
    onSelectTab: vi.fn(),
    wxmlTree: null,
    onRefreshWxml: vi.fn(),
    appData: { bridges: [], activeBridgeId: null, entries: {} },
    onRefreshAppData: vi.fn(),
    onSelectAppDataBridge: vi.fn(),
    storageItems: [],
    onRefreshStorage: vi.fn(),
    onSetStorage: okWrite,
    onRemoveStorage: okWrite,
    onClearStorage: okWrite,
    onClearAllStorage: okWrite,
    getStoragePrefix: async () => '',
  }
}

/**
 * The new props don't exist on BottomDebugPanelProps yet — pass them via a
 * separately-typed spread (JSX spreads of non-literal objects skip excess
 * property checks), so this file typechecks in the red phase AND keeps
 * working once the props land.
 */
function renderPanel(selected: RightPaneTabId, logs: CompileLogShape[]) {
  const baseProps = makeBaseProps(selected)
  const compileProps = {
    compileEvents: [] as Array<{ at: number; status: string; message: string }>,
    onClearCompileEvents: vi.fn(),
    compileLogs: logs,
  }
  const utils = render(<BottomDebugPanel {...baseProps} {...compileProps} />)
  return { ...utils, baseProps, compileProps }
}

describe('BottomDebugPanel: compileLogs passthrough (ROUND 2 — dmcc 日志链路)', () => {
  it('feeds compileLogs into the compile tab body as CompilePanel log rows', () => {
    const { container } = renderPanel('compile', [
      { at: Date.now(), stream: 'stderr', text: '✖ 编译页面逻辑 [FAILED: 透传探针]' },
    ])

    const panel = container.querySelector<HTMLElement>('[data-tab-panel="compile"]')
    expect(
      panel,
      'the compile tab needs its [data-tab-panel="compile"] body (wave-1 contract)',
    ).not.toBeNull()

    const logRow = panel!.querySelector<HTMLElement>('[data-compile-log]')
    expect(
      logRow,
      'BottomDebugPanel must pass compileLogs through to CompilePanel — the log row never rendered',
    ).not.toBeNull()
    expect(logRow!.textContent).toContain('✖ 编译页面逻辑 [FAILED: 透传探针]')
    expect(logRow!.getAttribute('data-stream')).toBe('stderr')
  })

  it('renders log rows even while another tab is selected (keepalive body, wave-1 pattern)', () => {
    const { container } = renderPanel('wxml', [
      { at: Date.now(), stream: 'stdout', text: '✔ 输出编译产物' },
    ])

    const panel = container.querySelector<HTMLElement>('[data-tab-panel="compile"]')
    expect(panel, 'compile tabpanel stays mounted (display:none keepalive)').not.toBeNull()
    expect(
      panel!.querySelector('[data-compile-log]'),
      'the keepalive-hidden compile body must still receive compileLogs',
    ).not.toBeNull()
  })
})
