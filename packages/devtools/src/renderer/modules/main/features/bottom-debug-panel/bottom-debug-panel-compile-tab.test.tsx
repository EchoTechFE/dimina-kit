/**
 * 编译信息 tab — BottomDebugPanel wiring contract (TDD, NOT yet implemented).
 *
 * Pinned contract:
 *  - TABS gains `{ id: 'compile', label: '编译' }` appended AFTER Console —
 *    tab order is pinned: WXML / AppData / Storage / Console / 编译.
 *    (`RightPaneTabId`'s builtin union in project-runtime/types.ts gains
 *    'compile' — not assertable at runtime because the union is open.)
 *  - Clicking 编译 calls `onSelectTab('compile')` and triggers NONE of the
 *    wxml/appdata/storage refresh callbacks.
 *  - New props `compileEvents` + `onClearCompileEvents` flow into a
 *    `CompilePanel` rendered in a `[data-tab-panel="compile"]` body.
 *  - Tab bodies use the EXISTING keepalive pattern (verified against today's
 *    bottom-debug-panel.tsx:125-128): panels stay mounted and toggle
 *    `display`, so the compile tabpanel must exist with display:none while
 *    another tab is selected.
 *
 * Sibling panels are mocked to inert stubs — this suite is about the tab bar
 * and the compile wiring, not WXML/AppData/Storage internals. CompilePanel is
 * NOT mocked: the selected-tab tests integrate through the real component
 * (red until right-panel/compile-panel.tsx exists).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { BottomDebugPanel, type BottomDebugPanelProps } from './bottom-debug-panel'
import type { RightPaneTabId } from '../project-runtime/types'

vi.mock('../right-panel/wxml-panel.js', () => ({ WxmlPanel: () => null }))
vi.mock('../right-panel/appdata-panel.js', () => ({ AppDataPanel: () => null }))
vi.mock('../right-panel/storage-panel.js', () => ({ StoragePanel: () => null }))

interface CompileEventShape {
  at: number
  status: string
  message: string
  hotReload?: boolean
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
function makeCompileProps(events: CompileEventShape[] = []) {
  return {
    compileEvents: events,
    onClearCompileEvents: vi.fn(),
  }
}

function renderPanel(selected: RightPaneTabId, events: CompileEventShape[] = []) {
  const baseProps = makeBaseProps(selected)
  const compileProps = makeCompileProps(events)
  const utils = render(<BottomDebugPanel {...baseProps} {...compileProps} />)
  return { ...utils, baseProps, compileProps }
}

describe('BottomDebugPanel: 编译 tab', () => {
  it('pins the tab order: WXML / AppData / Storage / Console / 编译', () => {
    const { getAllByRole } = renderPanel('wxml')
    expect(
      getAllByRole('tab').map((tab) => tab.textContent),
      '编译 must be appended after Console — the five-tab order is part of the contract',
    ).toEqual(['WXML', 'AppData', 'Storage', 'Console', '编译'])
  })

  it("clicking 编译 calls onSelectTab('compile') and triggers no sibling refresh", () => {
    const { getByRole, baseProps } = renderPanel('wxml')

    fireEvent.click(getByRole('tab', { name: '编译' }))

    expect(baseProps.onSelectTab).toHaveBeenCalledTimes(1)
    expect(baseProps.onSelectTab).toHaveBeenCalledWith('compile')
    // The compile log is push-fed by projectStatus — selecting the tab must
    // not piggyback a wxml/appdata/storage refresh.
    expect(baseProps.onRefreshWxml).not.toHaveBeenCalled()
    expect(baseProps.onRefreshAppData).not.toHaveBeenCalled()
    expect(baseProps.onRefreshStorage).not.toHaveBeenCalled()
  })

  it('renders the CompilePanel body (fed by compileEvents) when the compile tab is selected', () => {
    const { container, getAllByText } = renderPanel('compile', [
      { at: Date.now(), status: 'ready', message: '编译完成-集成探针' },
    ])

    const panel = container.querySelector<HTMLElement>('[data-tab-panel="compile"]')
    expect(
      panel,
      'the compile tab needs a [data-tab-panel="compile"] body like every other tab',
    ).not.toBeNull()
    expect(panel!.style.display).not.toBe('none')
    // The event message must surface inside the panel (badge and/or row).
    expect(getAllByText(/编译完成-集成探针/).length).toBeGreaterThanOrEqual(1)
  })

  it('keeps the compile tabpanel mounted with display:none when another tab is selected (keepalive pattern)', () => {
    const { container } = renderPanel('wxml', [
      { at: Date.now(), status: 'ready', message: '编译完成' },
    ])

    const panel = container.querySelector<HTMLElement>('[data-tab-panel="compile"]')
    expect(
      panel,
      'tab bodies use the existing display:none keepalive — the compile panel must stay mounted while hidden',
    ).not.toBeNull()
    expect(panel!.style.display).toBe('none')
  })

  it('the 清空 button inside the compile panel drives onClearCompileEvents', () => {
    const { getByRole, compileProps } = renderPanel('compile', [
      { at: Date.now(), status: 'ready', message: '编译完成' },
    ])

    fireEvent.click(getByRole('button', { name: '清空' }))
    expect(compileProps.onClearCompileEvents).toHaveBeenCalledTimes(1)
  })
})
