import { useEffect, useState } from 'react'
import { Button } from '@/shared/components/ui/button'
import { cn } from '@/shared/lib/utils'
import { closePanel, closePanelForUser } from '@dimina-kit/electron-deck/layout'
import type { LayoutModel, PanelRegistry } from '@dimina-kit/electron-deck/layout'
import { buildPresetDockTree, listPanelVisibility, reopenPanel } from '../layout/dock-layout'
import type { DevtoolsPosition, LayoutStoreApi, SimulatorAlignment } from '../controllers/use-layout-store'

/** The five built-in debug panels managed by the single "调试器" toggle. */
const DEBUG_PANELS = ['wxml', 'appdata', 'storage', 'console', 'compile']

interface LayoutControlsProps {
  model: LayoutModel
  registry: PanelRegistry
  /** Current device width — seeds a reopened simulator's fixed-px column. */
  simPanelWidth: number
}

/**
 * Three independent icon-button toggles for simulator / editor / debug
 * visibility — the toolbar affordance from before the dockable rewrite, restored
 * on top of the dock tree. User hide requests honor registry `closable`;
 * "show" uses `reopenPanel` to restore a missing panel at its default-aligned
 * position. The "调试器" toggle operates on all five debug panels as one region:
 * region visibility is DECOUPLED from each panel's per-tab `closable` capability —
 * the debug panels are `closable:false` (no per-tab ×), yet this toggle hides the
 * whole region via the raw `closePanel` mutation. The last visible region can't be
 * hidden (closing the sole panel is an engine no-op, so the UI would desync).
 *
 * Active state design (matching the historical control): active → filled icon +
 * `bg-surface-active` chip + accent ring; inactive → outline icon, de-emphasised.
 */
export function LayoutVisibilityToggles({ model, registry, simPanelWidth }: LayoutControlsProps) {
  // Re-render on every model emission so the toggles track live visibility (a
  // tab × close, a drag, or another toggle).
  const [, force] = useState(0)
  useEffect(() => model.subscribe(() => force((n) => n + 1)), [model])

  const open = new Set(
    listPanelVisibility(model.get(), registry).filter((p) => p.open).map((p) => p.id),
  )
  const simulatorVisible = open.has('simulator')
  const editorVisible = open.has('editor')
  const debugVisible = DEBUG_PANELS.some((p) => open.has(p))

  // The number of currently-visible REGIONS — used to disable hiding the last
  // one (closing the sole panel is an engine no-op, so the UI would desync).
  const visibleRegions = [simulatorVisible, editorVisible, debugVisible].filter(Boolean).length

  function toggleSingle(id: string, visible: boolean) {
    model.apply((t) => (
      visible ? closePanelForUser(t, id, registry) : reopenPanel(t, id, simPanelWidth)
    ))
  }

  function toggleDebug() {
    if (debugVisible) {
      // Hide the whole region as a unit. Region visibility is decoupled from each
      // panel's `closable` capability, so use the raw `closePanel` mutation rather
      // than `closePanelForUser` — the debug panels are `closable:false` (no
      // per-tab ×) yet the region toggle may still hide them all.
      const present = DEBUG_PANELS.filter((p) => open.has(p))
      model.apply((t) => present.reduce((tree, p) => closePanel(tree, p), t))
    } else {
      // Show the region: reopen the debug panels that are absent (idempotent).
      const absent = DEBUG_PANELS.filter((p) => !open.has(p))
      model.apply((t) => absent.reduce((tree, p) => reopenPanel(tree, p, simPanelWidth), t))
    }
  }

  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="面板可见性">
      <ToggleButton
        active={simulatorVisible}
        disabled={simulatorVisible && visibleRegions === 1}
        onClick={() => toggleSingle('simulator', simulatorVisible)}
        title={simulatorVisible ? '隐藏模拟器' : '显示模拟器'}
        testId="layout-toolbar-toggle-simulator"
        icon={<SimulatorIcon filled={simulatorVisible} />}
      />
      <ToggleButton
        active={editorVisible}
        disabled={editorVisible && visibleRegions === 1}
        onClick={() => toggleSingle('editor', editorVisible)}
        title={editorVisible ? '隐藏编辑器' : '显示编辑器'}
        testId="layout-toolbar-toggle-editor"
        icon={<EditorIcon filled={editorVisible} />}
      />
      <ToggleButton
        active={debugVisible}
        disabled={debugVisible && visibleRegions === 1}
        onClick={toggleDebug}
        title={debugVisible ? '隐藏调试器' : '显示调试器'}
        testId="layout-toolbar-toggle-debug"
        icon={<DebugIcon filled={debugVisible} />}
      />
    </div>
  )
}

interface PresetControlsProps {
  model: LayoutModel
  layout: LayoutStoreApi
  simPanelWidth: number
}

/**
 * Swap the simulator column between the left and right edge. Like the historical
 * control there is no "off" state — the icon reflects the current side. Applies a
 * full preset rebuild (alignment × the current devtools-position).
 */
export function LayoutAlignmentToggle({ model, layout, simPanelWidth }: PresetControlsProps) {
  const { simulatorAlignment, devtoolsPosition } = layout.state
  const isLeft = simulatorAlignment === 'left'
  function flip() {
    const next: SimulatorAlignment = isLeft ? 'right' : 'left'
    layout.setSimulatorAlignment(next)
    model.apply(() => buildPresetDockTree(simPanelWidth, next, devtoolsPosition))
  }
  return (
    <Button
      variant="icon"
      size="icon"
      onClick={flip}
      title={isLeft ? '模拟器位置：左侧（点击切换到右侧）' : '模拟器位置：右侧（点击切换到左侧）'}
      data-testid="layout-toolbar-alignment-toggle"
      data-alignment={simulatorAlignment}
      className="text-text-muted hover:text-text hover:bg-surface-3"
    >
      <AlignmentIcon side={simulatorAlignment} />
    </Button>
  )
}

/**
 * Three-button radio for the devtools/debug region position preset
 * (inEditor / belowSimulator / rightOfSimulator). Clicking applies a full preset
 * rebuild (the current alignment × the chosen position) and records it for the
 * highlight.
 */
export function LayoutDevtoolsPositionToggles({ model, layout, simPanelWidth }: PresetControlsProps) {
  const { simulatorAlignment, devtoolsPosition } = layout.state
  function apply(position: DevtoolsPosition) {
    layout.setDevtoolsPosition(position)
    model.apply(() => buildPresetDockTree(simPanelWidth, simulatorAlignment, position))
  }
  const presets: { id: DevtoolsPosition; title: string }[] = [
    { id: 'inEditor', title: '调试器位置：在编辑器面板中' },
    { id: 'belowSimulator', title: '调试器位置：在模拟器下方' },
    { id: 'rightOfSimulator', title: '调试器位置：在模拟器右侧' },
  ]
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="调试器位置">
      {presets.map((p) => (
        <ToggleButton
          key={p.id}
          active={devtoolsPosition === p.id}
          onClick={() => apply(p.id)}
          title={p.title}
          testId={`layout-toolbar-devtools-${p.id}`}
          icon={<DevtoolsPositionIcon variant={p.id} />}
        />
      ))}
    </div>
  )
}

function ToggleButton({
  active,
  disabled,
  onClick,
  title,
  testId,
  icon,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  title: string
  testId: string
  icon: React.ReactNode
}) {
  return (
    <Button
      variant="icon"
      size="icon"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      data-testid={testId}
      data-active={active ? 'true' : 'false'}
      className={cn(
        'text-text-muted/45 hover:text-text-muted hover:bg-surface-3',
        active && 'bg-surface-active text-text ring-1 ring-accent/50 hover:bg-surface-active hover:text-text',
      )}
    >
      {icon}
    </Button>
  )
}

// Icons take `filled`: when true the body is painted (`fill="currentColor"`),
// otherwise the outline variant — the shape delta is the primary "this panel is
// on" affordance (restored verbatim from the pre-dockable toolbar).

function SimulatorIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {filled ? (
        <>
          <rect x="4" y="1.5" width="8" height="13" rx="1.5" fill="currentColor" stroke="currentColor" />
          <line x1="6.5" y1="12.5" x2="9.5" y2="12.5" stroke="var(--color-surface-2)" strokeWidth="1.2" />
        </>
      ) : (
        <>
          <rect x="4" y="1.5" width="8" height="13" rx="1.5" />
          <line x1="6.5" y1="12.5" x2="9.5" y2="12.5" />
        </>
      )}
    </svg>
  )
}

function EditorIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={filled ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="5,4 1.5,8 5,12" />
      <polyline points="11,4 14.5,8 11,12" />
      <line x1="9.5" y1="3" x2="6.5" y2="13" />
    </svg>
  )
}

function DebugIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {filled ? (
        <ellipse cx="8" cy="9" rx="3.5" ry="4.5" fill="currentColor" stroke="currentColor" />
      ) : (
        <ellipse cx="8" cy="9" rx="3.5" ry="4.5" />
      )}
      <line x1="6" y1="3.5" x2="5" y2="2" />
      <line x1="10" y1="3.5" x2="11" y2="2" />
      <line x1="4.5" y1="7.5" x2="2" y2="6.5" />
      <line x1="4.5" y1="9.5" x2="2" y2="9.5" />
      <line x1="4.5" y1="11.5" x2="2" y2="12.5" />
      <line x1="11.5" y1="7.5" x2="14" y2="6.5" />
      <line x1="11.5" y1="9.5" x2="14" y2="9.5" />
      <line x1="11.5" y1="11.5" x2="14" y2="12.5" />
    </svg>
  )
}

/** Two-pane miniature with the simulator's current side filled in. */
function AlignmentIcon({ side }: { side: SimulatorAlignment }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      {side === 'left' ? (
        <rect x="2.6" y="3.6" width="4.8" height="8.8" rx="0.8" fill="currentColor" stroke="none" />
      ) : (
        <rect x="8.6" y="3.6" width="4.8" height="8.8" rx="0.8" fill="currentColor" stroke="none" />
      )}
    </svg>
  )
}

/** 16×16 miniatures of the three devtools-position presets (the devtools
 * sub-region is the filled block). */
function DevtoolsPositionIcon({ variant }: { variant: DevtoolsPosition }) {
  if (variant === 'inEditor') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <line x1="6.5" y1="3" x2="6.5" y2="13" />
        <rect x="7.1" y="8.5" width="6.3" height="4" rx="0.6" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  if (variant === 'belowSimulator') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <line x1="8" y1="3" x2="8" y2="13" />
        <rect x="2.6" y="8.5" width="4.8" height="4" rx="0.6" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1="6" y1="3" x2="6" y2="13" />
      <line x1="9.5" y1="3" x2="9.5" y2="13" />
      <rect x="6.3" y="3.6" width="3" height="8.8" rx="0.6" fill="currentColor" stroke="none" />
    </svg>
  )
}
