import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { render } from '@testing-library/react'
import { FrameTree } from './frame-tree'
import { compileProjectWindowLayout } from './compile'
import type { LayoutState } from '../controllers/use-layout-store'
import type { CellId } from './types'

// react-resizable-panels touches ResizeObserver during its layout effect;
// jsdom doesn't provide one. Stub the minimum surface area.
class StubResizeObserver {
  observe(): void { /* noop */ }
  unobserve(): void { /* noop */ }
  disconnect(): void { /* noop */ }
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
})

afterAll(() => {
  vi.unstubAllGlobals()
})

/**
 * Component-level smoke tests for `FrameTree`. We assert:
 *
 *   (a) The e2e selectors required by `wechat-layout.spec.ts` survive:
 *       - `[data-area="editor"]`
 *       - manual splitter has `role="separator"` and `data-orientation`
 *       - `[data-area="simulator-devtools"]` reachable via the debug
 *         binding ref (we provide a fake cellNode that uses the ref).
 *
 *   (b) The structural invariant that `<Panel>`s are direct children of
 *       `<Group>` (react-resizable-panels requires this). We verify via
 *       DOM traversal that each panel element's parent in the DOM has
 *       the Group's data attribute.
 *
 *   (c) The simulator leaf renders the provided cell node verbatim (no
 *       placeholder div wrapping).
 *
 * These tests use jsdom and the real `react-resizable-panels` library.
 */

function makeStubs(): {
  cellNodes: Record<CellId, JSX.Element>
  refs: Record<'editor' | 'debug', (el: HTMLElement | null) => void>
  debugDivRef: { current: HTMLDivElement | null }
} {
  const debugDivRef: { current: HTMLDivElement | null } = { current: null }
  const refs = {
    editor: vi.fn(),
    debug: vi.fn((el: HTMLElement | null) => {
      debugDivRef.current = el as HTMLDivElement | null
    }),
  }
  const cellNodes: Record<CellId, JSX.Element> = {
    simulator: <div data-testid="sim-stub">SIM</div>,
    // The editor cell now renders the caller-provided node verbatim (the
    // real <MonacoEditor/> root carries `data-area="editor"`), so the stub
    // mirrors that — no more FrameTree-owned placeholder.
    editor: <div data-area="editor" data-testid="editor-stub">EDITOR</div>,
    debug: (
      <div data-testid="debug-stub">
        {/* Simulates BottomDebugPanel's forwarded ref onto its inner
            simulator-devtools placeholder. */}
        <div
          ref={refs.debug}
          data-area="simulator-devtools"
          data-tab-panel="simulator"
        />
      </div>
    ),
  }
  return { cellNodes, refs, debugDivRef }
}

function fullyVisibleState(
  devtoolsPosition: 'inEditor' | 'belowSimulator' | 'rightOfSimulator',
  simulatorAlignment: 'left' | 'right' = 'left',
): LayoutState {
  return {
    devtoolsPosition,
    simulatorAlignment,
    simulatorVisible: true,
    editorVisible: true,
    debugVisible: true,
  }
}

describe('FrameTree — e2e selectors survive', () => {
  it('inEditor / left renders [data-area="editor"]', () => {
    const stubs = makeStubs()
    const layout = compileProjectWindowLayout(fullyVisibleState('inEditor'))
    const { container } = render(
      <FrameTree
        layout={layout}
        cellNodes={stubs.cellNodes}
        simPanelWidth={400}
        onSimSplitterDrag={() => {}}
      />,
    )
    expect(container.querySelector('[data-area="editor"]')).not.toBeNull()
  })

  it('manual splitter has role=separator + data-orientation', () => {
    const stubs = makeStubs()
    const layout = compileProjectWindowLayout(fullyVisibleState('inEditor'))
    const { container } = render(
      <FrameTree
        layout={layout}
        cellNodes={stubs.cellNodes}
        simPanelWidth={400}
        onSimSplitterDrag={() => {}}
      />,
    )
    const manual = container.querySelector('[data-splitter="sim"]')
    expect(manual).not.toBeNull()
    expect(manual!.getAttribute('role')).toBe('separator')
    expect(manual!.getAttribute('data-orientation')).toBe('vertical')
  })

  it('debug ref attaches to BottomDebugPanel-style placeholder', () => {
    const stubs = makeStubs()
    const layout = compileProjectWindowLayout(fullyVisibleState('inEditor'))
    render(
      <FrameTree
        layout={layout}
        cellNodes={stubs.cellNodes}
        simPanelWidth={400}
        onSimSplitterDrag={() => {}}
      />,
    )
    expect(stubs.refs.debug).toHaveBeenCalled()
    expect(stubs.debugDivRef.current).not.toBeNull()
    expect(stubs.debugDivRef.current!.getAttribute('data-area')).toBe('simulator-devtools')
  })

  // NOTE: removed "editor ref attaches to the leaf placeholder" — the editor
  // cell is now an in-renderer <MonacoEditor/>, not a main-process overlay, so
  // it no longer carries a bounds RefCallback (`cellRefs.editor`). Only the
  // debug cell's Chromium DevTools overlay still uses a bounds ref.
})

describe('FrameTree — Panel/Group structural invariant', () => {
  // react-resizable-panels requires every <Panel> to be a direct child of its
  // <Group> (a <Separator> may sit between sibling Panels, but the Panel's DOM
  // parent is always the Group element). The rendered attributes are
  // `data-panel` on Panel and `data-group` on Group. `rightOfSimulator`
  // compiles to a resizable Group (debug + editor) nested inside the fixed-px
  // sim row, so it exercises the real Group path.
  it('every [data-panel] parent carries [data-group]', () => {
    const stubs = makeStubs()
    const layout = compileProjectWindowLayout(fullyVisibleState('rightOfSimulator'))
    const { container } = render(
      <FrameTree
        layout={layout}
        cellNodes={stubs.cellNodes}
        simPanelWidth={400}
        onSimSplitterDrag={() => {}}
      />,
    )
    const panels = container.querySelectorAll('[data-panel]')
    // Guard against a vacuous pass: this layout must produce a real Group.
    expect(panels.length).toBeGreaterThan(0)
    panels.forEach((panel) => {
      const parent = panel.parentElement
      expect(parent).not.toBeNull()
      expect(parent!.hasAttribute('data-group')).toBe(true)
    })
  })
})

describe('FrameTree — base modes render without crashing', () => {
  it.each([
    fullyVisibleState('inEditor', 'left'),
    fullyVisibleState('inEditor', 'right'),
    fullyVisibleState('belowSimulator', 'left'),
    fullyVisibleState('belowSimulator', 'right'),
    fullyVisibleState('rightOfSimulator', 'left'),
    fullyVisibleState('rightOfSimulator', 'right'),
  ])(
    'state=$devtoolsPosition/$simulatorAlignment renders',
    (state) => {
      const stubs = makeStubs()
      const layout = compileProjectWindowLayout(state)
      const { container } = render(
        <FrameTree
          layout={layout}
          cellNodes={stubs.cellNodes}
          simPanelWidth={400}
          onSimSplitterDrag={() => {}}
        />,
      )
      // sim cell node renders verbatim
      expect(container.querySelector('[data-testid="sim-stub"]')).not.toBeNull()
      // debug cell renders
      expect(container.querySelector('[data-testid="debug-stub"]')).not.toBeNull()
      // editor placeholder renders
      expect(container.querySelector('[data-area="editor"]')).not.toBeNull()
    },
  )
})

describe('FrameTree — collapsed states', () => {
  it('only sim visible renders just the sim cell', () => {
    const stubs = makeStubs()
    const layout = compileProjectWindowLayout({
      devtoolsPosition: 'inEditor',
      simulatorAlignment: 'left',
      simulatorVisible: true,
      editorVisible: false,
      debugVisible: false,
    })
    const { container } = render(
      <FrameTree
        layout={layout}
        cellNodes={stubs.cellNodes}
        simPanelWidth={400}
        onSimSplitterDrag={() => {}}
      />,
    )
    expect(container.querySelector('[data-testid="sim-stub"]')).not.toBeNull()
    expect(container.querySelector('[data-area="editor"]')).toBeNull()
    expect(container.querySelector('[data-testid="debug-stub"]')).toBeNull()
    // No splitter should be rendered when sim is the sole survivor
    // (collapseRoot dissolves the row, so no plain-flex Row + splitter
    // remains).
    expect(container.querySelector('[data-splitter="sim"]')).toBeNull()
  })

  it('belowSimulator + sim hidden + editor+debug visible renders both panels (no resizable-group crash)', () => {
    // Regression test for codex round-7 #1: flex/flex Row was being
    // sent to renderResizableGroup which requires resizable children.
    const stubs = makeStubs()
    const layout = compileProjectWindowLayout({
      devtoolsPosition: 'belowSimulator',
      simulatorAlignment: 'left',
      simulatorVisible: false,
      editorVisible: true,
      debugVisible: true,
    })
    const { container } = render(
      <FrameTree
        layout={layout}
        cellNodes={stubs.cellNodes}
        simPanelWidth={400}
        onSimSplitterDrag={() => {}}
      />,
    )
    expect(container.querySelector('[data-area="editor"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="debug-stub"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="sim-stub"]')).toBeNull()
  })

  it('only editor visible renders just the editor placeholder', () => {
    const stubs = makeStubs()
    const layout = compileProjectWindowLayout({
      devtoolsPosition: 'inEditor',
      simulatorAlignment: 'left',
      simulatorVisible: false,
      editorVisible: true,
      debugVisible: false,
    })
    const { container } = render(
      <FrameTree
        layout={layout}
        cellNodes={stubs.cellNodes}
        simPanelWidth={400}
        onSimSplitterDrag={() => {}}
      />,
    )
    expect(container.querySelector('[data-area="editor"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="sim-stub"]')).toBeNull()
    expect(container.querySelector('[data-testid="debug-stub"]')).toBeNull()
  })
})
