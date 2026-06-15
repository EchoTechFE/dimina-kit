/**
 * Contract tests for `DebugTabContent` — the reusable per-tab content renderer.
 *
 * HISTORY / WHY THIS FILE SHRANK:
 *   A layout consolidation DELETED the `BottomDebugPanel` React container (its
 *   tab strip + the per-tab tabpanel bodies + Console placeholder). The module
 *   `bottom-debug-panel.tsx` now exports ONLY `DebugTabContent`, the per-tab
 *   content renderer, plus the `DebugTabContentId` / `BottomDebugPanelProps`
 *   types. Console is a NATIVE main-process overlay, not a DebugTabContent case.
 *
 *   The two `describe('BottomDebugPanel default mode (regression-lock …)')`
 *   blocks (tab-strip order via [data-bottom-debug-tabs] / getAllByRole('tab'),
 *   and the [data-tab-panel] keepalive bodies + Console placeholder) guarded a
 *   component that NO LONGER EXISTS. They are REMOVED, not relaxed-to-stay-green:
 *   there is nothing left to lock, so the lock is deleted along with the
 *   `import { BottomDebugPanel }`. We intentionally do NOT migrate tab-strip
 *   order, onSelectTab, or [data-tab-panel] keepalive — those tested the deleted
 *   container.
 *
 *   `DebugTabContent` was previously a NOT-YET-EXISTING export read off the
 *   module namespace at runtime (a red-phase workaround) — it now exists, so it
 *   is imported directly. The red-phase "is exported as a usable React
 *   component" typeof check is dropped (it only existed to fail before the
 *   export landed).
 *
 * What lives here now:
 *   - The reusable-renderer tests: `<DebugTabContent tabId=… />` renders the
 *     right per-tab panel (WxmlPanel / AppDataPanel / StoragePanel /
 *     CompilePanel) and forwards every handler.
 *   - Migrated compile-data-flow coverage from two DELETED sibling test files
 *     that exercised the SAME data flow THROUGH the (now-deleted) container; the
 *     behavior now lives in DebugTabContent tabId='compile'.
 *
 * The four content panels are NOT mocked: these tests integrate through the
 * real WxmlPanel / AppDataPanel / StoragePanel / CompilePanel so we exercise
 * real handler wiring (a refresh button actually firing the spy) and real DOM
 * (the compile log/event rows actually rendered), not identity.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, within } from '@testing-library/react'
import {
  DebugTabContent,
  type BottomDebugPanelProps,
} from './bottom-debug-panel'
import type { WxmlNode } from '../right-panel/types'

const okWrite = async () => ({ ok: true as const })

/** A minimal one-node WXML tree whose 刷新 button is always rendered. */
function makeWxmlTree(): WxmlNode {
  return {
    tagName: 'view',
    attrs: {},
    children: [],
    sid: 'sid-root',
  } as unknown as WxmlNode
}

/**
 * Full prop bag for DebugTabContent. Spies are individually overridable so a
 * test can assert a specific handler fires.
 */
function makeProps(
  overrides: Partial<BottomDebugPanelProps> = {},
): BottomDebugPanelProps {
  return {
    rightPane: { selected: 'wxml', simulatorVisible: true },
    onSelectTab: vi.fn(),
    wxmlTree: makeWxmlTree(),
    onRefreshWxml: vi.fn(),
    onInspectWxml: vi.fn(async () => null),
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
    compileEvents: [],
    compileLogs: [],
    onClearCompileEvents: vi.fn(),
    ...overrides,
  }
}

// ── DebugTabContent: reusable per-tab unit renders + forwards handlers ──────

describe('DebugTabContent (reusable per-tab unit)', () => {
  it("tabId='wxml' renders the WXML panel and forwards onRefreshWxml", () => {
    // Bug guarded: a dropped refresh handler when extracting wxml content —
    // clicking the panel's 刷新 button must reach the caller's spy.
    const onRefreshWxml = vi.fn()
    const props = makeProps({ onRefreshWxml })
    const { getByTestId } = render(<DebugTabContent tabId="wxml" {...props} />)

    const panel = getByTestId('wxml-panel')
    fireEvent.click(within(panel).getByRole('button', { name: /刷新/ }))
    expect(onRefreshWxml).toHaveBeenCalledTimes(1)
  })

  it("tabId='appdata' renders the AppData panel and forwards onRefreshAppData", () => {
    // Bug guarded: AppData refresh wiring dropped during extraction. The
    // AppData panel always renders its 刷新 button.
    const onRefreshAppData = vi.fn()
    const props = makeProps({ onRefreshAppData })
    const { getByRole } = render(<DebugTabContent tabId="appdata" {...props} />)

    fireEvent.click(getByRole('button', { name: /刷新/ }))
    expect(onRefreshAppData).toHaveBeenCalledTimes(1)
  })

  it("tabId='appdata' forwards onSelectAppDataBridge when a bridge is chosen", () => {
    // Bug guarded: the bridge-selector handler dropped during extraction. With
    // >1 bridge, the panel renders a button per bridge wired to onSelectBridge.
    const onSelectAppDataBridge = vi.fn()
    const props = makeProps({
      onSelectAppDataBridge,
      appData: {
        bridges: [
          { id: 'b1', pagePath: 'pages/a' },
          { id: 'b2', pagePath: 'pages/b' },
        ],
        activeBridgeId: 'b1',
        entries: {},
      } as BottomDebugPanelProps['appData'],
    })
    const { getByRole } = render(<DebugTabContent tabId="appdata" {...props} />)

    fireEvent.click(getByRole('button', { name: 'pages/b' }))
    expect(onSelectAppDataBridge).toHaveBeenCalledWith('b2')
  })

  it("tabId='storage' renders the Storage panel and forwards onRefreshStorage", () => {
    // Bug guarded: storage refresh handler dropped during extraction.
    const onRefreshStorage = vi.fn()
    const props = makeProps({ onRefreshStorage })
    const { getByTestId } = render(
      <DebugTabContent tabId="storage" {...props} />,
    )

    const panel = getByTestId('storage-panel')
    fireEvent.click(within(panel).getByRole('button', { name: /刷新/ }))
    expect(onRefreshStorage).toHaveBeenCalledTimes(1)
  })

  it("tabId='compile' renders the Compile panel and forwards onClearCompileEvents", () => {
    // Bug guarded: the compile 清空 handler dropped during extraction. The
    // panel renders a 清空 button wired to onClear.
    const onClearCompileEvents = vi.fn()
    const props = makeProps({
      onClearCompileEvents,
      compileEvents: [
        // shape per CompileEvent; only `message` surfaces in the badge.
        { at: Date.now(), status: 'ready', message: '编译完成' },
      ] as unknown as BottomDebugPanelProps['compileEvents'],
    })
    const { getByRole } = render(<DebugTabContent tabId="compile" {...props} />)

    fireEvent.click(getByRole('button', { name: '清空' }))
    expect(onClearCompileEvents).toHaveBeenCalledTimes(1)
  })
})

// ── Migrated compile data-flow coverage ─────────────────────────────────────
//
// Migrated from two DELETED sibling test files that drove the SAME compile
// feed THROUGH the now-deleted BottomDebugPanel container. The underlying
// behavior now lives in DebugTabContent tabId='compile', so we assert it
// directly against the real CompilePanel render.

describe('DebugTabContent tabId=compile — compile feed flows into CompilePanel', () => {
  it('renders a compileLogs line as a [data-compile-log] row with the right stream', () => {
    // Bug guarded: a compile LOG line dropped on the way into CompilePanel —
    // the per-line dmcc log must reach the rendered [data-compile-log] row,
    // tagged with its stream so stderr lines are distinguishable.
    const text = '✖ 编译页面逻辑 [FAILED: 透传探针]'
    const props = makeProps({
      compileLogs: [
        { at: Date.now(), stream: 'stderr', text },
      ] as unknown as BottomDebugPanelProps['compileLogs'],
    })
    const { container } = render(<DebugTabContent tabId="compile" {...props} />)

    const row = container.querySelector('[data-compile-log]')
    expect(row, 'a [data-compile-log] row must be rendered for the log line').not.toBeNull()
    expect(row!.textContent).toContain(text)
    expect(row!.getAttribute('data-stream')).toBe('stderr')
  })

  it('surfaces a compileEvents message in the rendered output', () => {
    // Bug guarded: a compile EVENT message dropped on the way into CompilePanel
    // — the event's message text must surface somewhere in the rendered panel.
    const message = '编译完成-集成探针'
    const props = makeProps({
      compileEvents: [
        { at: Date.now(), status: 'ready', message },
      ] as unknown as BottomDebugPanelProps['compileEvents'],
    })
    const { container } = render(<DebugTabContent tabId="compile" {...props} />)

    expect(container.textContent).toContain(message)
  })
})
