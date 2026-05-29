import { Fragment, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react'
import { Panel, Group } from 'react-resizable-panels'
import { ResizeHandle } from '@/shared/components/layout/resize-handle'
import {
  splitterHitArea,
  splitterVisibleBar,
} from '@/shared/components/layout/splitter-styles'
import type {
  CellId,
  Frame,
  FrameChild,
  FrameRow,
  FrameColumn,
  ProjectWindowLayout,
} from './types'

/**
 * Render context shared across the recursive `renderFrame` calls.
 *
 * `cellNodes` provides the JSX for each business cell — typically:
 *   simulator → `<SimulatorPanel ... />`
 *   editor    → `<MonacoEditor ... />` rendered directly in the main
 *               renderer (no overlay and no bounds binding)
 *   debug     → `<BottomDebugPanel ref={…} ... />` (ref comes from
 *               `project-runtime`'s `useViewAnchor`, not from FrameTree)
 *
 * `FrameTree` owns no bounds wiring: it renders each `cellNode` verbatim.
 * The debug cell's DevTools overlay ref is supplied by `project-runtime`
 * via `useViewAnchor` (see `@/lib/view-anchor`); simulator (`<webview>`)
 * and editor (Monaco) are plain DOM, so they have no ref.
 */
export interface FrameTreeProps {
  layout: ProjectWindowLayout
  cellNodes: Record<CellId, ReactNode>
  /** Current sim column pixel width (from `useDevice`). */
  simPanelWidth: number
  /** Drag handler from `useDevice`. The `side` arg tells it which side of
   *  the sim column the splitter is rendered on, so the delta sign is
   *  correct for both `alignment=left` (trailing) and `right` (leading). */
  onSimSplitterDrag: (e: ReactMouseEvent, side: 'leading' | 'trailing') => void
}

interface RenderContext {
  cellNodes: Record<CellId, ReactNode>
  simPanelWidth: number
  onSimSplitterDrag: (e: ReactMouseEvent, side: 'leading' | 'trailing') => void
}

/**
 * Top-level renderer for a `ProjectWindowLayout`. Dispatches on the root
 * frame shape and recurses. The component itself owns no state — it is a
 * pure function of the compiled layout plus the device and ref props.
 */
export function FrameTree(props: FrameTreeProps): ReactNode {
  const ctx: RenderContext = {
    cellNodes: props.cellNodes,
    simPanelWidth: props.simPanelWidth,
    onSimSplitterDrag: props.onSimSplitterDrag,
  }
  return renderFrame(props.layout.root, ctx)
}

// ── Recursive renderer ────────────────────────────────────────────────

function renderFrame(frame: Frame, ctx: RenderContext): ReactNode {
  if (frame.kind === 'leaf') return renderLeaf(frame.cellId, ctx)
  // Dispatch rules:
  //   - Any `fixed-px-with-splitter` child → plain flex Row (manual
  //     splitter; `react-resizable-panels` is incompatible with the
  //     pixel-fixed sim column).
  //   - All `resizable` children → `react-resizable-panels` Group
  //     (Panel/Separator must be direct Group children).
  //   - Otherwise (any `flex` child, or mixed) → plain flex container.
  //     Compile produces flex/flex Rows in transitional states like
  //     `belowSimulator + sim hidden`, and `react-resizable-panels` does
  //     not accept non-resizable children. (codex round-7 #1).
  if (hasFixedPxChild(frame)) return renderPlainFlexRow(frame, ctx)
  if (allResizable(frame)) return renderResizableGroup(frame, ctx)
  return renderPlainFlex(frame, ctx)
}

function hasFixedPxChild(frame: FrameRow | FrameColumn): boolean {
  return frame.children.some((c) => c.outerSize.kind === 'fixed-px-with-splitter')
}

function allResizable(frame: FrameRow | FrameColumn): boolean {
  return frame.children.every((c) => c.outerSize.kind === 'resizable')
}

// ── Leaf ──────────────────────────────────────────────────────────────

function renderLeaf(cellId: CellId, ctx: RenderContext): ReactNode {
  // Every cell renders the caller-provided node verbatim:
  //   - editor    : an in-renderer <MonacoEditor/> (no overlay, no bounds).
  //   - simulator : the device shell + <webview>.
  //   - debug     : <BottomDebugPanel>, whose inner
  //                 `[data-area="simulator-devtools"]` placeholder carries
  //                 the DevTools overlay's bounds ref — supplied by
  //                 `project-runtime`'s `useViewAnchor`, not by FrameTree.
  return ctx.cellNodes[cellId]
}

// ── Resizable group (react-resizable-panels) ─────────────────────────

function renderResizableGroup(
  frame: FrameRow | FrameColumn,
  ctx: RenderContext,
): ReactNode {
  // Every child must be `resizable` to use the Group path. If a sibling
  // is `flex`, the renderer dispatches to plain-flex via `hasFixedPxChild`
  // check above (flex shouldn't coexist with resizable in the same group
  // — the compile output never produces such mixed groups).
  const orientation = frame.kind === 'row' ? 'horizontal' : 'vertical'
  const handleDirection = frame.kind === 'row' ? 'horizontal' : 'vertical'

  // Stable group key: forces the Group to remount when child set / order
  // changes, ensuring `defaultSize` is reapplied (we don't use
  // `autoSaveId` for size persistence in v1; see design note R1).
  const groupKey = frame.children.map((c) => c.slotId).join('|')

  const elements: ReactNode[] = []
  frame.children.forEach((child, i) => {
    if (child.outerSize.kind !== 'resizable') {
      // Defensive: a flex sibling here would mean compile produced an
      // illegal mix. Throw loudly in dev so the compile bug is caught
      // by tests rather than silently mis-rendering at runtime.
      if (process.env.NODE_ENV !== 'production') {
        throw new Error(
          `FrameTree: resizable group child has non-resizable outerSize: ${child.outerSize.kind}`,
        )
      }
      return
    }
    if (i > 0) {
      elements.push(<ResizeHandle key={`rh-${i}`} direction={handleDirection} />)
    }
    elements.push(
      <Panel
        key={child.slotId}
        id={child.slotId}
        defaultSize={child.outerSize.defaultSize}
        minSize={child.outerSize.minSize}
        className="overflow-hidden"
      >
        {renderFrame(child.frame, ctx)}
      </Panel>,
    )
  })

  return (
    <Group key={groupKey} orientation={orientation} className="h-full w-full">
      {elements}
    </Group>
  )
}

// ── Plain flex (no resizable handles, no manual splitter) ───────────

/**
 * Render a container whose children are some combination of `flex` and
 * `resizable` (no `fixed-px-with-splitter`), using plain CSS flex.
 *
 * This handles compile outputs like `Row[debug(flex), editor(flex)]`
 * (produced by `belowSimulator + sim hidden + editor + debug visible`)
 * where `react-resizable-panels` cannot be used because flex children
 * are not Panels.
 *
 * `resizable` children that find themselves on this path (a legal
 * fallback after collapse-driven sizing demotion) render as `flex-1`
 * since the resizable-panels Group is no longer available to honor
 * their `defaultSize` / `minSize`.
 */
function renderPlainFlex(
  frame: FrameRow | FrameColumn,
  ctx: RenderContext,
): ReactNode {
  const direction = frame.kind === 'row' ? 'flex h-full w-full' : 'flex flex-col h-full w-full'
  return (
    <div className={direction}>
      {frame.children.map((child) => (
        <div
          key={child.slotId}
          className="flex-1 min-w-0 min-h-0 overflow-hidden"
        >
          {renderFrame(child.frame, ctx)}
        </div>
      ))}
    </div>
  )
}

// ── Plain flex with fixed-px sim column (manual splitter) ─────────────

function renderPlainFlexRow(
  frame: FrameRow | FrameColumn,
  ctx: RenderContext,
): ReactNode {
  // We only emit plain flex on Rows (fixed-px is width-on-Row only). A
  // FrameColumn carrying fixed-px would mean fixed-height which is not
  // a supported policy. Compile should never produce that — we throw
  // defensively.
  if (frame.kind !== 'row') {
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(
        'FrameTree: fixed-px-with-splitter is only valid on Row children, not Column',
      )
    }
    return null
  }

  return (
    <div className="flex h-full w-full">
      {frame.children.map((child, i) => renderPlainFlexChild(child, i, ctx))}
    </div>
  )
}

function renderPlainFlexChild(
  child: FrameChild,
  index: number,
  ctx: RenderContext,
): ReactNode {
  const inner = renderFrame(child.frame, ctx)

  if (child.outerSize.kind === 'fixed-px-with-splitter') {
    const side = child.outerSize.splitterSide
    const splitter = (
      <Splitter
        key={`sim-splitter-${index}`}
        side={side}
        onDrag={ctx.onSimSplitterDrag}
      />
    )
    const fixedDiv = (
      <div
        key={child.slotId}
        className="shrink-0 h-full overflow-hidden"
        style={{ width: ctx.simPanelWidth }}
      >
        {inner}
      </div>
    )
    // `leading` ⇒ splitter sits to the left of the fixed child;
    // `trailing` ⇒ splitter sits to the right.
    return side === 'leading' ? (
      <Fragment key={`sim-${index}`}>{splitter}{fixedDiv}</Fragment>
    ) : (
      <Fragment key={`sim-${index}`}>{fixedDiv}{splitter}</Fragment>
    )
  }

  if (child.outerSize.kind === 'flex') {
    return (
      <div key={child.slotId} className="flex-1 min-w-0 h-full overflow-hidden">
        {inner}
      </div>
    )
  }

  // resizable child mixed into a plain-flex row — not produced by
  // compile, but treat as flex-1 if it ever appears (defensive).
  return (
    <div key={child.slotId} className="flex-1 min-w-0 h-full overflow-hidden">
      {inner}
    </div>
  )
}

function Splitter(props: {
  side: 'leading' | 'trailing'
  onDrag: (e: ReactMouseEvent, side: 'leading' | 'trailing') => void
}): ReactNode {
  // Same hit-area + visible-bar styling as `ResizeHandle` so both kinds of
  // divider read as one consistent 1px line (see `splitter-styles`). The
  // visible line is vertical here (sim column splits horizontally).
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      data-orientation="vertical"
      data-splitter="sim"
      className={splitterHitArea('vertical')}
      onMouseDown={(e) => props.onDrag(e, props.side)}
    >
      <div className={`${splitterVisibleBar} h-full w-px`} />
    </div>
  )
}
