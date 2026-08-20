import { useEffect, useState } from 'react'
import { Bug, Code2, PanelLeft, PanelRight, Smartphone } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { cn } from '@/shared/lib/utils'
import { useOverlayTooltip } from '@/shared/lib/use-overlay-tooltip'
import { closePanel, closePanelForUser } from '@dimina-kit/electron-deck/layout'
import type { LayoutModel, PanelRegistry } from '@dimina-kit/electron-deck/layout'
import { buildPresetDockTree, DEFAULT_DEBUG_PANELS, listPanelVisibility, reopenPanel } from '../layout/dock-layout'
import type { DevtoolsPosition, LayoutStoreApi, SimulatorAlignment } from '../controllers/use-layout-store'

/** The five built-in debug panels managed by the single "调试器" toggle —
 * shared with the restore-time heal so both read one set. */
const DEBUG_PANELS = DEFAULT_DEBUG_PANELS

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
 * Active state: `ghost` variant (full-contrast --qd-foreground icon) plus an
 * explicit --color-surface-active chip. `primary-soft` was tried first but its
 * icon/chip contrast sits right at the WCAG 3:1 UI-component floor, which
 * washes out a 2px-stroke icon in dark mode; `secondary` was tried next but
 * --qd-secondary is IDENTICAL to this toolbar's own --color-surface-2 chrome
 * tone in light mode (both #f7f7f9) — the chip became invisible, silently
 * dropping the selected-state affordance (caught via a live light-mode
 * screenshot showing all three toggles looking unselected). --color-surface-active
 * is devtools-owned specifically so it can't collide with either theme's chrome
 * tone. Inactive → de-emphasised (60% opacity). Icons are plain lucide glyphs —
 * the chip alone carries the on/off affordance, so no separate filled/outline
 * icon variant is needed.
 *
 * Tooltips in this toolbar (here and in LayoutAlignmentToggle /
 * LayoutDevtoolsPositionToggles) use `useOverlayTooltip` (a dedicated tooltip
 * overlay WebContentsView), NOT the `ui/tooltip` Radix component and NOT the
 * native `title` attribute — DO NOT "upgrade" this to either. This row sits
 * directly above the Simulator/Editor native WebContentsViews; Electron
 * composites those as separate surfaces above ALL of the host window's own
 * web content (including its browser-drawn `title` tooltip, which lives in
 * that same paint surface), so anything that pops toward those regions
 * renders BEHIND the WCV — invisible, no CSS z-index or OS tooltip layer can
 * reach above a native view from inside the main window's own renderer.
 * Confirmed live twice: first a Radix Tooltip migration, then a `title`
 * fallback, both silently broke every tooltip in this row (user-reported,
 * unreproducible via CDP screenshot since Page.captureScreenshot doesn't
 * composite WCVs either — real mouse hover in the actual app was needed to
 * see it). `useOverlayTooltip` renders in its OWN top-tier WebContentsView
 * (VIEW_LAYER.tooltip, above even settings/popover), the same placement
 * mechanism that already keeps those two above the simulator/editor.
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
        label={simulatorVisible ? '隐藏模拟器' : '显示模拟器'}
        testId="layout-toolbar-toggle-simulator"
        icon={<Smartphone className="size-3.5" />}
      />
      <ToggleButton
        active={editorVisible}
        disabled={editorVisible && visibleRegions === 1}
        onClick={() => toggleSingle('editor', editorVisible)}
        label={editorVisible ? '隐藏编辑器' : '显示编辑器'}
        testId="layout-toolbar-toggle-editor"
        icon={<Code2 className="size-3.5" />}
      />
      <ToggleButton
        active={debugVisible}
        disabled={debugVisible && visibleRegions === 1}
        onClick={toggleDebug}
        label={debugVisible ? '隐藏调试器' : '显示调试器'}
        testId="layout-toolbar-toggle-debug"
        icon={<Bug className="size-3.5" />}
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
  const label = isLeft ? '模拟器位置：左侧（点击切换到右侧）' : '模拟器位置：右侧（点击切换到左侧）'
  const tooltip = useOverlayTooltip(label)
  return (
    <Button
      variant="icon"
      size="icon"
      onClick={flip}
      aria-label={label}
      data-testid="layout-toolbar-alignment-toggle"
      data-alignment={simulatorAlignment}
      {...tooltip}
    >
      {isLeft ? <PanelLeft className="size-3.5" /> : <PanelRight className="size-3.5" />}
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
  const presets: { id: DevtoolsPosition; label: string }[] = [
    { id: 'inEditor', label: '调试器位置：在编辑器面板中' },
    { id: 'belowSimulator', label: '调试器位置：在模拟器下方' },
    { id: 'rightOfSimulator', label: '调试器位置：在模拟器右侧' },
  ]
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="调试器位置">
      {presets.map((p) => (
        <ToggleButton
          key={p.id}
          active={devtoolsPosition === p.id}
          onClick={() => apply(p.id)}
          label={p.label}
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
  label,
  testId,
  icon,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  label: string
  testId: string
  icon: React.ReactNode
}) {
  const tooltip = useOverlayTooltip(label)
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      data-active={active ? 'true' : 'false'}
      className={cn(
        active ? 'bg-[var(--color-surface-active)]' : 'opacity-60',
      )}
      {...tooltip}
    >
      {icon}
    </Button>
  )
}

/** 24×24-grid miniatures of the three devtools-position presets (the devtools
 * sub-region is the filled block), drawn in lucide's stroke convention so
 * they sit consistently alongside the imported icons in this toolbar. */
function DevtoolsPositionIcon({ variant }: { variant: DevtoolsPosition }) {
  if (variant === 'inEditor') {
    return (
      <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="9" y1="3" x2="9" y2="21" />
        <path d="M9 15h12" />
        <rect x="9" y="15" width="12" height="6" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  if (variant === 'belowSimulator') {
    return (
      <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="12" y1="3" x2="12" y2="21" />
        <path d="M3 15h9" />
        <rect x="3" y="15" width="9" height="6" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  return (
    <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <line x1="15" y1="3" x2="15" y2="21" />
      <rect x="9" y="3" width="6" height="18" fill="currentColor" stroke="none" />
    </svg>
  )
}
