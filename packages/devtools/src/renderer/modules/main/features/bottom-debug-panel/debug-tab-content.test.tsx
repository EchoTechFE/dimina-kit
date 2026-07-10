/**
 * Contract tests for `DebugTabContent` — the reusable per-tab content renderer.
 *
 * The module `bottom-debug-panel.tsx` exports `DebugTabContent` (the per-tab
 * content renderer) plus the `DebugTabContentId` / `BottomDebugPanelProps`
 * types. Console is a NATIVE main-process overlay, not a DebugTabContent case.
 *
 * What lives here:
 *   - The reusable-renderer tests: `<DebugTabContent tabId=… />` renders the
 *     right per-tab panel (WxmlPanel / AppDataPanel / StoragePanel /
 *     CompilePanel) and forwards every handler.
 *   - Compile-data-flow coverage via DebugTabContent tabId='compile'.
 *
 * The four content panels are NOT mocked: these tests integrate through the
 * real WxmlPanel / AppDataPanel / StoragePanel / CompilePanel so we exercise
 * real rendering + handler wiring (bridge selection, compile clear) and real DOM
 * (the compile log/event rows actually rendered), not identity. The panels are
 * live-synced and carry NO refresh button, so DebugTabContent
 * no longer forwards an `onRefresh` to them — the per-tab guard is that each
 * tabId mounts its own panel.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import {
  DebugTabContent,
  type BottomDebugPanelProps,
} from './bottom-debug-panel'
import type { WxmlNode, WxmlPanelSource } from '@dimina-kit/wxml-inspect'

const okWrite = async () => ({ ok: true as const })

/** A minimal one-node WXML tree served through the fake source. */
function makeWxmlTree(): WxmlNode {
  return {
    tagName: 'view',
    attrs: {},
    children: [],
    sid: 'sid-root',
  } as unknown as WxmlNode
}

/** Inert WxmlPanelSource: seeds the minimal tree, never pushes live updates. */
function makeWxmlSource(): WxmlPanelSource {
  return {
    getSnapshot: async () => makeWxmlTree(),
    subscribe: () => () => {},
    setActive: () => {},
    inspect: async () => null,
    clearInspection: () => {},
  }
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
    wxmlSource: makeWxmlSource(),
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
  it("tabId='wxml' renders the WXML panel", () => {
    // Bug guarded: the wrong panel (or none) mounts for tabId='wxml'. The panel
    // is live-synced with no refresh button, so we assert it mounts rather than
    // clicking a (removed) refresh control.
    const props = makeProps()
    const { getByTestId } = render(<DebugTabContent tabId="wxml" {...props} />)

    expect(getByTestId('wxml-panel')).toBeTruthy()
  })

  it("tabId='appdata' renders the AppData panel", () => {
    // Bug guarded: the wrong panel mounts for tabId='appdata'.
    const props = makeProps()
    const { getByTestId } = render(<DebugTabContent tabId="appdata" {...props} />)

    expect(getByTestId('appdata-panel')).toBeTruthy()
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

  it("tabId='storage' renders the Storage panel", () => {
    // Bug guarded: the wrong panel mounts for tabId='storage'.
    const props = makeProps()
    const { getByTestId } = render(
      <DebugTabContent tabId="storage" {...props} />,
    )

    expect(getByTestId('storage-panel')).toBeTruthy()
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
