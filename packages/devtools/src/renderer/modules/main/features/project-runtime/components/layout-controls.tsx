import { Button } from '@/shared/components/ui/button'
import { cn } from '@/shared/lib/utils'
import type { LayoutStoreApi, SimulatorAlignment, DevtoolsPosition } from '../controllers/use-layout-store'

interface LayoutControlsProps {
  layout: LayoutStoreApi
}

/**
 * Three independent icon-button toggles for simulator / editor / debug
 * visibility. Sits in the toolbar so frequent show/hide is one click.
 *
 * Active state design (after iterating on user feedback that pure
 * text-color contrast was not noticeable enough):
 *   - active   → filled icon (svg fill="currentColor") + bg-surface-active
 *                chip + ring-1 ring-accent/50 + text-text
 *   - inactive → outline icon (stroke="currentColor", fill="none") +
 *                no background + text-text-muted/45 (de-emphasised)
 * The shape change (solid vs outline) carries the signal even when the
 * color delta is subtle, matching the WeChat toolbar pattern.
 */
export function LayoutVisibilityToggles({ layout }: LayoutControlsProps) {
  const { state, visibleCount } = layout
  const simulatorDisabled = state.simulatorVisible && visibleCount === 1
  const editorDisabled = state.editorVisible && visibleCount === 1
  const debugDisabled = state.debugVisible && visibleCount === 1

  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="面板可见性">
      <ToggleButton
        active={state.simulatorVisible}
        disabled={simulatorDisabled}
        onClick={layout.toggleSimulator}
        title={state.simulatorVisible ? '隐藏模拟器' : '显示模拟器'}
        testId="layout-toolbar-toggle-simulator"
        icon={<SimulatorIcon filled={state.simulatorVisible} />}
      />
      <ToggleButton
        active={state.editorVisible}
        disabled={editorDisabled}
        onClick={layout.toggleEditor}
        title={state.editorVisible ? '隐藏编辑器' : '显示编辑器'}
        testId="layout-toolbar-toggle-editor"
        icon={<EditorIcon filled={state.editorVisible} />}
      />
      <ToggleButton
        active={state.debugVisible}
        disabled={debugDisabled}
        onClick={layout.toggleDebug}
        title={state.debugVisible ? '隐藏调试器' : '显示调试器'}
        testId="layout-toolbar-toggle-debug"
        icon={<DebugIcon filled={state.debugVisible} />}
      />
    </div>
  )
}

/**
 * Single toggle button that swaps simulator alignment between left and
 * right. Unlike the visibility toggles there is no "off" state — the
 * icon itself reflects the current alignment (highlighted block on the
 * left vs the right), and the button is never rendered with the
 * surface-active chip. This keeps the affordance unambiguous without
 * pretending one side is the "primary" alignment.
 */
export function LayoutAlignmentToggle({ layout }: LayoutControlsProps) {
  const { state, setSimulatorAlignment } = layout
  const isLeft = state.simulatorAlignment === 'left'
  return (
    <Button
      variant="icon"
      size="icon"
      onClick={() => setSimulatorAlignment(isLeft ? 'right' : 'left')}
      title={isLeft ? '模拟器位置：左侧（点击切换到右侧）' : '模拟器位置：右侧（点击切换到左侧）'}
      data-testid="layout-toolbar-alignment-toggle"
      data-alignment={state.simulatorAlignment}
      className="text-text-muted hover:text-text hover:bg-surface-3"
    >
      <AlignmentIcon side={state.simulatorAlignment} />
    </Button>
  )
}

/**
 * Three-button group for devtools position presets (button-group
 * variant of a radio): inEditor / belowSimulator / rightOfSimulator.
 * Active button gets the same surface-active chip + accent ring as the
 * visibility toggles so the whole toolbar reads as one toggle family.
 */
export function LayoutDevtoolsPositionToggles({ layout }: LayoutControlsProps) {
  const { state, setDevtoolsPosition } = layout
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="调试器位置">
      <ToggleButton
        active={state.devtoolsPosition === 'inEditor'}
        onClick={() => setDevtoolsPosition('inEditor')}
        title="调试器位置：在编辑器面板中"
        testId="layout-toolbar-devtools-inEditor"
        icon={<DevtoolsPositionIcon variant="inEditor" />}
      />
      <ToggleButton
        active={state.devtoolsPosition === 'belowSimulator'}
        onClick={() => setDevtoolsPosition('belowSimulator')}
        title="调试器位置：在模拟器下方"
        testId="layout-toolbar-devtools-belowSimulator"
        icon={<DevtoolsPositionIcon variant="belowSimulator" />}
      />
      <ToggleButton
        active={state.devtoolsPosition === 'rightOfSimulator'}
        onClick={() => setDevtoolsPosition('rightOfSimulator')}
        title="调试器位置：在模拟器右侧"
        testId="layout-toolbar-devtools-rightOfSimulator"
        icon={<DevtoolsPositionIcon variant="rightOfSimulator" />}
      />
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
        // Inactive: outline icon, muted color, no background chip.
        'text-text-muted/45 hover:text-text-muted hover:bg-surface-3',
        // Active: solid chip with the project's selected-background
        // (matches tab-active / right-pane selected). Bordered ring on
        // top of bg gives a clear pressed-toolbar-button look in dark
        // themes where alpha-tinted accents wash out.
        active && 'bg-surface-active text-text ring-1 ring-accent/50 hover:bg-surface-active hover:text-text',
      )}
    >
      {icon}
    </Button>
  )
}

// Each icon takes `filled`: when true we paint the body with
// `fill="currentColor"`, otherwise we render the outline variant
// (fill="none", stroke="currentColor"). The shape delta is the primary
// affordance for "this panel is on right now".

function SimulatorIcon({ filled }: { filled: boolean }) {
  // Phone outline (lucide 'smartphone' style).
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
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
  // Angle brackets `</>`.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={filled ? 2 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="5,4 1.5,8 5,12" />
      <polyline points="11,4 14.5,8 11,12" />
      <line x1="9.5" y1="3" x2="6.5" y2="13" />
    </svg>
  )
}

function DebugIcon({ filled }: { filled: boolean }) {
  // Bug (lucide 'bug' simplified).
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {filled ? (
        <ellipse cx="8" cy="9" rx="3.5" ry="4.5" fill="currentColor" stroke="currentColor" />
      ) : (
        <ellipse cx="8" cy="9" rx="3.5" ry="4.5" />
      )}
      {/* antennae */}
      <line x1="6" y1="3.5" x2="5" y2="2" />
      <line x1="10" y1="3.5" x2="11" y2="2" />
      {/* legs */}
      <line x1="4.5" y1="7.5" x2="2" y2="6.5" />
      <line x1="4.5" y1="9.5" x2="2" y2="9.5" />
      <line x1="4.5" y1="11.5" x2="2" y2="12.5" />
      <line x1="11.5" y1="7.5" x2="14" y2="6.5" />
      <line x1="11.5" y1="9.5" x2="14" y2="9.5" />
      <line x1="11.5" y1="11.5" x2="14" y2="12.5" />
    </svg>
  )
}

/**
 * Two-pane miniature where one side is filled to indicate the
 * simulator's current alignment. Left-filled means the simulator is on
 * the left; right-filled means the right side.
 */
function AlignmentIcon({ side }: { side: SimulatorAlignment }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      {side === 'left' ? (
        <rect x="2.6" y="3.6" width="4.8" height="8.8" rx="0.8" fill="currentColor" stroke="none" />
      ) : (
        <rect x="8.6" y="3.6" width="4.8" height="8.8" rx="0.8" fill="currentColor" stroke="none" />
      )}
    </svg>
  )
}

/**
 * 16x16 miniatures of the three devtools-position presets. Each glyph
 * is the project layout with the devtools sub-region filled in:
 *   - inEditor:         editor pane on the right with a filled lower
 *                        sub-strip representing the devtools tab.
 *   - belowSimulator:   left column split, lower half is the filled
 *                        devtools strip; editor occupies the right.
 *   - rightOfSimulator: three columns; the middle column is the
 *                        devtools strip.
 */
function DevtoolsPositionIcon({
  variant,
}: {
  variant: DevtoolsPosition
}) {
  const stroke = 'currentColor'
  if (variant === 'inEditor') {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke={stroke}
        strokeWidth="1.2"
        aria-hidden="true"
      >
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        {/* divider between simulator (left) and editor (right) */}
        <line x1="6.5" y1="3" x2="6.5" y2="13" />
        {/* filled devtools strip inside the editor pane (lower half) */}
        <rect x="7.1" y="8.5" width="6.3" height="4" rx="0.6" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  if (variant === 'belowSimulator') {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke={stroke}
        strokeWidth="1.2"
        aria-hidden="true"
      >
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        {/* divider between left column (sim + debug) and editor (right) */}
        <line x1="8" y1="3" x2="8" y2="13" />
        {/* filled devtools strip below the simulator (left lower half) */}
        <rect x="2.6" y="8.5" width="4.8" height="4" rx="0.6" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  // rightOfSimulator
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke={stroke}
      strokeWidth="1.2"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      {/* two dividers → three columns (sim | debug | editor) */}
      <line x1="6" y1="3" x2="6" y2="13" />
      <line x1="9.5" y1="3" x2="9.5" y2="13" />
      {/* filled devtools middle column */}
      <rect x="6.3" y="3.6" width="3" height="8.8" rx="0.6" fill="currentColor" stroke="none" />
    </svg>
  )
}
