/**
 * Devtools "dockable mode" — layout-engine glue.
 *
 * Builds a `@dimina-kit/electron-deck` layout model for the devtools business
 * panels from the persisted, opaque serialized tree. The engine
 * (createLayoutModel / parse / validate / serialize) and `<DockView>` do the
 * real nesting + resize work; this module is only the registry + a default-tree
 * seed + a fallback-safe restore.
 *
 * The coarse `debug` panel is split into FIVE independent dock panels —
 * wxml / appdata / storage / console / compile — so each is its own dockable
 * unit. `console` is the only NATIVE panel (a main-process WebContentsView
 * routed through DockView's NativeSlot). `simulator` is a DOM panel:
 * `renderDomPanel('simulator')` renders `SimulatorPanel`, which draws the
 * device/zoom chrome AND owns the simulator WebContentsView anchor itself (a
 * bare native slot would render no chrome). editor + the four React-content
 * debug tabs (wxml/appdata/storage/compile) are DOM panels too. The simulator
 * leaf is floored at the device's pixel width via a `minPx` constraint so the
 * phone-region never shrinks below it; its sibling stays weight-sized (an all-fixed
 * split is rejected by `validateTree`).
 */
import {
  createLayoutModel,
  createPanelRegistry,
  insertPanel,
  parseLayout,
  sanitizeFlexibleWeights,
  setConstraint,
  splitPanel,
  validateTree,
} from '@dimina-kit/electron-deck/layout'
import type {
  LayoutModel,
  LayoutNode,
  LayoutTree,
  PanelRegistry,
} from '@dimina-kit/electron-deck/layout'
import type { DevtoolsPosition, SimulatorAlignment } from '../controllers/use-layout-store'

/**
 * Register the seven dock panels: DOM simulator + native console + DOM
 * editor + the four React-content debug tabs (wxml/appdata/storage/compile).
 *
 * `simulator` is a DOM panel: `renderDomPanel('simulator')` renders the
 * `SimulatorPanel` CHROME (device/zoom pickers, compile overlays, page-path
 * bar) and SimulatorPanel itself owns the main-process WebContentsView anchor
 * on its device-region div (via `createPlacementAnchor`). DockView's bare
 * `NativeSlot` would render no chrome, so the simulator cannot be native.
 *
 * `console` IS native: a main-process Chromium DevTools WebContentsView
 * overlaid onto a bare placeholder rect (no chrome). The four debug tabs are
 * DOM panels so `renderDomPanel` renders their React content.
 */
export function buildDockRegistry(): PanelRegistry {
  const registry = createPanelRegistry()
  // simulator + editor are STRUCTURAL panels: `draggable:false` locks their tabs
  // (can't be picked up) AND makes them invalid drop anchors (nothing may
  // join/split onto them). The five debug panels are `reorder-only`: draggable,
  // but a drag may ONLY reorder them within their own tab strip — never tear them
  // out into the simulator/editor regions. See PanelCapabilities in electron-deck.
  // simulator + editor draw their own chrome (device picker / file path bar), so
  // they hide the engine tab entirely — their groups render no tab strip.
  registry.register({ kind: 'dom', id: 'simulator', title: 'Simulator', draggable: false, hideTab: true })
  registry.register({ kind: 'dom', id: 'editor', title: 'Editor', draggable: false, hideTab: true })
  registry.register({ kind: 'dom', id: 'wxml', title: 'WXML', dropPolicy: 'reorder-only' })
  registry.register({ kind: 'dom', id: 'appdata', title: 'AppData', dropPolicy: 'reorder-only' })
  registry.register({ kind: 'dom', id: 'storage', title: 'Storage', dropPolicy: 'reorder-only' })
  registry.register({
    kind: 'native',
    id: 'console',
    title: 'Console',
    nativeRef: { id: 'console' },
    dropPolicy: 'reorder-only',
  })
  registry.register({ kind: 'dom', id: 'compile', title: '编译', dropPolicy: 'reorder-only' })
  return registry
}

/**
 * The default dock tree: a row split with the simulator pinned to
 * `simPanelWidth` px on the leading edge and a flexible column (editor over a
 * single tab strip holding the five debug panels) filling the rest. The five
 * debug panels (wxml/appdata/storage/console/compile) are co-located in ONE tab
 * group in pinned WeChat-DevTools order with WXML active, mirroring the legacy
 * BottomDebugPanel tab strip. Validates clean against the seven known ids.
 */
export function buildDefaultDockTree(simPanelWidth: number): LayoutTree {
  return {
    version: 1,
    root: {
      kind: 'split',
      id: 'root',
      orientation: 'row',
      // The simulator column is `minPx`-floored (flexible, never below the device
      // width) — a SMALL weight so it starts clamped at the device width while the
      // main column takes the rest; the user can drag the divider to widen it.
      sizes: [1, 6],
      constraints: [{ minPx: simPanelWidth }, null],
      children: [
        { kind: 'tabs', id: 'g-sim', panels: ['simulator'], active: 'simulator' },
        {
          kind: 'split',
          id: 'col-main',
          orientation: 'column',
          sizes: [70, 30],
          children: [
            { kind: 'tabs', id: 'g-editor', panels: ['editor'], active: 'editor' },
            {
              kind: 'tabs',
              id: 'g-debug',
              panels: ['wxml', 'appdata', 'storage', 'console', 'compile'],
              active: 'wxml',
            },
          ],
        },
      ],
    },
  }
}

// ── Toolbar layout PRESETS (alignment × devtools-position) ────────────────────
//
// The toolbar's alignment + devtools-position toggles apply a full preset
// layout — the dock-world equivalent of the old FrameTree presets. `inEditor` +
// `left` reproduces `buildDefaultDockTree`. Each preset places ALL seven panels
// (a preset is a "reset to this arrangement"); hide individual ones afterward
// with the visibility toggles.

const PRESET_DEBUG_GROUP = {
  kind: 'tabs' as const,
  id: 'g-debug',
  panels: ['wxml', 'appdata', 'storage', 'console', 'compile'],
  active: 'wxml',
}
const presetSimGroup = () => ({ kind: 'tabs' as const, id: 'g-sim', panels: ['simulator'], active: 'simulator' })
const presetEditorGroup = () => ({ kind: 'tabs' as const, id: 'g-editor', panels: ['editor'], active: 'editor' })
const presetDebugGroup = () => ({ ...PRESET_DEBUG_GROUP, panels: [...PRESET_DEBUG_GROUP.panels] })

/**
 * A `row` root with the simulator `minPx` floor on child `minIndex` (that child
 * is flexible but never shrinks below the device width) and weight sizes from
 * `weights` for every child. Give the simulator child a SMALL weight so it starts
 * clamped at the device width while the flexible siblings take the rest.
 * `children`/`weights` are in left→right order, already mirrored for alignment.
 */
function presetRow(children: LayoutNode[], minIndex: number, simPanelWidth: number, weights: number[]): LayoutTree {
  return {
    version: 1,
    root: {
      kind: 'split',
      id: 'root',
      orientation: 'row',
      sizes: children.map((_, i) => weights[i] ?? 1),
      constraints: children.map((_, i) => (i === minIndex ? { minPx: simPanelWidth } : null)),
      children,
    },
  }
}

/**
 * Build a full preset dock tree for a (alignment, devtoolsPosition) pair:
 *  - `inEditor`         — simulator column beside a [editor / debug] column.
 *  - `belowSimulator`   — [simulator / debug] column (floored at sim width) beside editor.
 *  - `rightOfSimulator` — three columns: simulator | debug | editor.
 * The simulator (or the column containing it) is `minPx`-floored at `simPanelWidth`
 * (flexible above it). `right` alignment mirrors the children order + the floor index.
 */
export function buildPresetDockTree(
  simPanelWidth: number,
  alignment: SimulatorAlignment,
  devtoolsPosition: DevtoolsPosition,
): LayoutTree {
  const left = alignment === 'left'
  if (devtoolsPosition === 'belowSimulator') {
    const simCol: LayoutNode = {
      kind: 'split',
      id: 'col-sim',
      orientation: 'column',
      sizes: [60, 40],
      children: [presetSimGroup(), presetDebugGroup()],
    }
    return left
      ? presetRow([simCol, presetEditorGroup()], 0, simPanelWidth, [1, 6])
      : presetRow([presetEditorGroup(), simCol], 1, simPanelWidth, [6, 1])
  }
  if (devtoolsPosition === 'rightOfSimulator') {
    return left
      ? presetRow([presetSimGroup(), presetDebugGroup(), presetEditorGroup()], 0, simPanelWidth, [1, 4, 5])
      : presetRow([presetEditorGroup(), presetDebugGroup(), presetSimGroup()], 2, simPanelWidth, [5, 4, 1])
  }
  // inEditor (default): simulator beside a [editor over debug] column.
  const mainCol: LayoutNode = {
    kind: 'split',
    id: 'col-main',
    orientation: 'column',
    sizes: [70, 30],
    children: [presetEditorGroup(), presetDebugGroup()],
  }
  return left
    ? presetRow([presetSimGroup(), mainCol], 0, simPanelWidth, [1, 6])
    : presetRow([mainCol, presetSimGroup()], 1, simPanelWidth, [6, 1])
}

/**
 * Build the observable model from the persisted (opaque) serialized tree.
 *
 * Fallback-safe: `null`, malformed JSON, a structurally-illegal tree, or a
 * structurally-valid-but-orphan tree (references a panel id outside
 * `knownPanelIds`) ALL fall back to the default tree at `simPanelWidth`. Only a
 * tree that round-trips through `parseLayout` AND passes `validateTree` clean
 * against `knownPanelIds` is restored verbatim.
 */
export function buildDockModel(
  serialized: string | null,
  simPanelWidth: number,
  knownPanelIds: ReadonlySet<string>,
): LayoutModel {
  const tree = restoreTreeOrDefault(serialized, simPanelWidth, knownPanelIds)
  return createLayoutModel(tree)
}

function restoreTreeOrDefault(
  serialized: string | null,
  simPanelWidth: number,
  knownPanelIds: ReadonlySet<string>,
): LayoutTree {
  if (serialized === null) return buildDefaultDockTree(simPanelWidth)
  try {
    const parsed = parseLayout(serialized)
    if (validateTree(parsed, knownPanelIds).length === 0) {
      // Heal any flexible child collapsed to a ~0 weight (a panel dragged to 0
      // width and persisted). `validateTree` only rejects non-FINITE sizes, not
      // non-positive ones, so a 0-weight tree round-trips clean yet restores an
      // invisible panel; `sanitizeFlexibleWeights` lifts such weights to a
      // minimum positive value. Px children are untouched. The force-persist of
      // a healed tree lives in `DockableLayout` (it re-serializes the model and
      // overwrites the stale localStorage value when it differs).
      return sanitizeFlexibleWeights(parsed)
    }
  } catch {
    // malformed JSON / structurally-illegal tree — fall through to default.
  }
  return buildDefaultDockTree(simPanelWidth)
}

// ── Panel visibility (reopen / list) ─────────────────────────────────────────
//
// In the dock model a panel is "hidden" by `closePanel` (the tab × or the
// toolbar Panels menu) — it leaves the tree entirely. These two pure helpers let
// the toolbar re-add a closed panel at a sensible default-aligned position and
// enumerate which panels are currently open, restoring the show/hide affordance
// the old toolbar layout toggles offered before the dockable rewrite.

/** The five debug panels, co-located in one tab group by `buildDefaultDockTree`.
 * A reopened debug panel rejoins whichever of these is still on screen. */
const DEFAULT_DEBUG_PANELS = ['wxml', 'appdata', 'storage', 'console', 'compile']

function collectPanelIds(node: LayoutNode, out: Set<string>): void {
  if (node.kind === 'tabs') {
    for (const p of node.panels) out.add(p)
    return
  }
  for (const child of node.children) collectPanelIds(child, out)
}

function panelIdsOf(tree: LayoutTree): Set<string> {
  const out = new Set<string>()
  collectPanelIds(tree.root, out)
  return out
}

/** The id of the tab group currently holding `panelId`, or `undefined`. */
function groupIdContaining(node: LayoutNode, panelId: string): string | undefined {
  if (node.kind === 'tabs') return node.panels.includes(panelId) ? node.id : undefined
  for (const child of node.children) {
    const hit = groupIdContaining(child, panelId)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** The first id in `candidates` that is currently present in the tree. */
function firstPresent(present: ReadonlySet<string>, candidates: readonly string[]): string | undefined {
  return candidates.find((id) => present.has(id))
}

/** The split id + child index of the IMMEDIATE split-parent of `groupId`, or
 * null when the group is the root (no parent split). */
function parentSplitSite(
  node: LayoutNode,
  groupId: string,
): { splitId: string; childIndex: number } | null {
  if (node.kind === 'tabs') return null
  for (let i = 0; i < node.children.length; i++) {
    if (node.children[i]!.id === groupId) return { splitId: node.id, childIndex: i }
    const hit = parentSplitSite(node.children[i]!, groupId)
    if (hit) return hit
  }
  return null
}

/** Re-pin the simulator's freshly-split column to its fixed device width so the
 * phone region never shrinks below it (mirrors the default tree's `minPx`). */
function pinSimulatorWidth(tree: LayoutTree, simPanelWidth: number): LayoutTree {
  const simGroupId = groupIdContaining(tree.root, 'simulator')
  if (!simGroupId) return tree
  const site = parentSplitSite(tree.root, simGroupId)
  if (!site) return tree
  return setConstraint(tree, site.splitId, site.childIndex, { minPx: simPanelWidth })
}

/**
 * Re-insert a currently-CLOSED panel back into the tree at a position aligned
 * with the default layout. Idempotent: reopening an already-present panel
 * returns the tree unchanged (never throws / never duplicates).
 *
 *  - A debug panel rejoins a surviving default debug sibling's tab group; if all
 *    siblings are gone it recreates a debug region below the editor (or beside
 *    the simulator).
 *  - `editor` re-splits above the debug region (or beside the simulator).
 *  - `simulator` re-splits as the leading column and is re-pinned to its fixed
 *    device width.
 */
export function reopenPanel(
  tree: LayoutTree,
  panelId: string,
  simPanelWidth: number,
): LayoutTree {
  const present = panelIdsOf(tree)
  if (present.has(panelId)) return tree

  // A debug panel: rejoin a surviving default mate's group when one is on screen.
  if (DEFAULT_DEBUG_PANELS.includes(panelId)) {
    const mate = DEFAULT_DEBUG_PANELS.find((m) => m !== panelId && present.has(m))
    if (mate) {
      const gid = groupIdContaining(tree.root, mate)!
      return insertPanel(tree, panelId, { groupId: gid })
    }
    // No debug mates left — recreate the debug region under the editor, else
    // beside the simulator, else under any surviving panel.
    if (present.has('editor')) return splitPanel(tree, 'editor', 'column', panelId, 'after')
    if (present.has('simulator')) return splitPanel(tree, 'simulator', 'row', panelId, 'after')
    return splitPanel(tree, [...present][0]!, 'column', panelId, 'after')
  }

  if (panelId === 'editor') {
    // Editor sits above the debug region in the main column.
    const debug = firstPresent(present, DEFAULT_DEBUG_PANELS)
    if (debug) return splitPanel(tree, debug, 'column', 'editor', 'before')
    if (present.has('simulator')) return splitPanel(tree, 'simulator', 'row', 'editor', 'after')
    return splitPanel(tree, [...present][0]!, 'column', 'editor', 'before')
  }

  if (panelId === 'simulator') {
    // Simulator is the leading fixed-width column.
    const anchor = firstPresent(present, ['editor', ...DEFAULT_DEBUG_PANELS]) ?? [...present][0]!
    const split = splitPanel(tree, anchor, 'row', 'simulator', 'before')
    return pinSimulatorWidth(split, simPanelWidth)
  }

  // Unknown panel — append beside any surviving panel (defensive; the 7 known
  // ids are all handled above).
  return splitPanel(tree, [...present][0]!, 'column', panelId, 'after')
}

/**
 * Enumerate every REGISTERED panel (in registry order) with whether it is
 * currently OPEN (present in the tree). Drives the toolbar Panels visibility
 * menu's checkmarks.
 */
export function listPanelVisibility(
  tree: LayoutTree,
  registry: PanelRegistry,
): { id: string; title: string; open: boolean }[] {
  const present = panelIdsOf(tree)
  return registry.list().map((d) => ({
    id: d.id,
    title: d.title ?? d.id,
    open: present.has(d.id),
  }))
}
