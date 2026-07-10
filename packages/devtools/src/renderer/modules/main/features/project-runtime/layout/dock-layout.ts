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
 * routed through DockView's NativeSlot). `simulator` and `editor` are DOM
 * panels: `renderDomPanel('simulator')` renders `SimulatorPanel` (device/zoom
 * chrome + the simulator WebContentsView anchor) and `renderDomPanel('editor')`
 * renders `EditorPanel` (a full-size anchor div owning the workbench
 * WebContentsView placement). Both are structural DOM bodies so the dock mounts
 * a `[data-deck-panel-body]` region for them. The four React-content debug tabs
 * (wxml/appdata/storage/compile) are DOM panels too. The simulator
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
  splitGroup,
  splitPanel,
  validateTree,
  wrapRoot,
} from '@dimina-kit/electron-deck/layout'
import type {
  LayoutModel,
  LayoutNode,
  LayoutTree,
  PanelRegistry,
} from '@dimina-kit/electron-deck/layout'
import type { DevtoolsPosition, SimulatorAlignment } from '../controllers/use-layout-store'

/**
 * Register the seven dock panels: DOM simulator + DOM editor + native console +
 * the four React-content debug tabs (wxml/appdata/storage/compile).
 *
 * `simulator` and `editor` are DOM panels: `renderDomPanel('simulator')`
 * renders the `SimulatorPanel` CHROME (device/zoom pickers, compile overlays,
 * page-path bar) owning the simulator WebContentsView anchor, and
 * `renderDomPanel('editor')` renders `EditorPanel`, a full-size anchor div that
 * owns the workbench WebContentsView placement (via `createPlacementAnchor`).
 * Both are structural DOM bodies so the dock mounts a `[data-deck-panel-body]`
 * region for them.
 *
 * `console` IS native: a main-process Chromium DevTools WebContentsView
 * overlaid onto a bare placeholder rect (no chrome). The four debug tabs are
 * DOM panels so `renderDomPanel` renders their React content.
 */
export function buildDockRegistry(): PanelRegistry {
  const registry = createPanelRegistry()
  // simulator + editor are STRUCTURAL panels: `draggable:false` locks their tabs
  // (can't be picked up) AND makes them invalid drop anchors (nothing may
  // join/split onto them). The five debug panels are `reorder-only` and
  // non-closable: draggable,
  // but a drag may ONLY reorder them within their own tab strip — never tear them
  // out into the simulator/editor regions, and their built-in tabs stay available.
  // See PanelCapabilities in electron-deck.
  // simulator + editor draw their own chrome (device picker / file path bar), so
  // they hide the engine tab entirely — their groups render no tab strip.
  registry.register({ kind: 'dom', id: 'simulator', title: 'Simulator', draggable: false, hideTab: true })
  // The 'editor' slot is the embedded VS Code workbench. It is a DOM panel
  // (like the simulator): `renderDomPanel('editor')` renders `EditorPanel`, a
  // full-size anchor div that owns the workbench WebContentsView placement
  // itself (via `createPlacementAnchor`). A bare native slot would render no
  // chrome and, more importantly, the editor must stay a structural DOM body so
  // the dock mounts a `[data-deck-panel-body="editor"]` region for it.
  registry.register({ kind: 'dom', id: 'editor', title: 'Editor', draggable: false, hideTab: true })
  registry.register({ kind: 'dom', id: 'wxml', title: 'WXML', dropPolicy: 'reorder-only', closable: false })
  registry.register({ kind: 'dom', id: 'appdata', title: 'AppData', dropPolicy: 'reorder-only', closable: false })
  registry.register({ kind: 'dom', id: 'storage', title: 'Storage', dropPolicy: 'reorder-only', closable: false })
  registry.register({
    kind: 'native',
    id: 'console',
    title: 'Console',
    nativeRef: { id: 'console' },
    dropPolicy: 'reorder-only',
    closable: false,
  })
  registry.register({ kind: 'dom', id: 'compile', title: '编译', dropPolicy: 'reorder-only', closable: false })
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
 * `knownPanelIds`) ALL fall back to the default tree at `simPanelWidth`. A tree
 * that round-trips through `parseLayout` AND passes `validateTree` clean
 * against `knownPanelIds` is restored, then reconciled: flexible weights are
 * sanitized and a partially-emptied debug strip is healed back to the full
 * built-in set (see `healMissingDebugPanels`).
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
      return healMissingDebugPanels(sanitizeFlexibleWeights(parsed), simPanelWidth)
    }
  } catch {
    // malformed JSON / structurally-illegal tree — fall through to default.
  }
  return buildDefaultDockTree(simPanelWidth)
}

/**
 * Reconcile a restored tree against the debug strip's ALL-OR-NOTHING invariant.
 *
 * At runtime the built-in debug panels can only leave the tree as a whole
 * region (the toolbar "调试器" toggle); per-tab close is blocked by
 * `closable:false`. A PERSISTED tree with a partial debug strip (>=1 but not
 * all of `DEFAULT_DEBUG_PANELS` present) is therefore never a user intent —
 * it is residue from an older build whose debug tabs were closable, or a tree
 * persisted before a newer built-in panel existed. Heal it: re-insert each
 * missing debug panel via `reopenPanel` (it rejoins the surviving mates' tab
 * group, keeping their order and the group's active tab). A tree with ZERO
 * debug panels is the legitimate region-hidden state and is left alone.
 */
function healMissingDebugPanels(tree: LayoutTree, simPanelWidth: number): LayoutTree {
  const present = panelIdsOf(tree)
  if (!DEFAULT_DEBUG_PANELS.some((p) => present.has(p))) return tree
  return DEFAULT_DEBUG_PANELS.reduce(
    (t, p) => (present.has(p) ? t : reopenPanel(t, p, simPanelWidth)),
    tree,
  )
}

// ── Panel visibility (reopen / list) ─────────────────────────────────────────
//
// In the dock model a panel is "hidden" by `closePanel` (the tab × or the
// toolbar Panels menu) — it leaves the tree entirely. These two pure helpers let
// the toolbar re-add a closed panel at a sensible default-aligned position and
// enumerate which panels are currently open, restoring the show/hide affordance
// the old toolbar layout toggles offered before the dockable rewrite.

/** The five built-in debug panels, co-located in one tab group by
 * `buildDefaultDockTree`. A reopened debug panel rejoins whichever of these is
 * still on screen. SINGLE truth for "what makes up the debug region": the
 * restore-time heal (`healMissingDebugPanels`) and the toolbar's region toggle
 * (`layout-controls.tsx`) both read this set. */
export const DEFAULT_DEBUG_PANELS = ['wxml', 'appdata', 'storage', 'console', 'compile']

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
 *  - `simulator` is re-attached as a top-level sibling of the ENTIRE rest of the
 *    tree (`wrapRoot`, not a `splitPanel` against one specific panel) and
 *    re-pinned to its fixed device width — nesting it inside just one sibling's
 *    slot would let the device-width floor consume that whole (already-narrower)
 *    slot, squeezing the sibling to zero rendered width.
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
    // Editor sits above the debug region in the main column. The debug region is
    // ONE multi-tab group (wxml/appdata/storage/console/compile) — split against
    // that GROUP, not one of its member panels: `splitPanel` targeting a panel
    // that belongs to a multi-panel group peels just that one tab out and strands
    // its siblings behind in the original group (WXML detaching from the
    // AppData/Storage/Console/编译 tab strip after an editor hide->show).
    const debug = firstPresent(present, DEFAULT_DEBUG_PANELS)
    if (debug) {
      const gid = groupIdContaining(tree.root, debug)!
      return splitGroup(tree, gid, 'column', 'editor', 'before')
    }
    if (present.has('simulator')) return splitPanel(tree, 'simulator', 'row', 'editor', 'after')
    return splitPanel(tree, [...present][0]!, 'column', 'editor', 'before')
  }

  if (panelId === 'simulator') {
    // Simulator is a top-level leading column beside the ENTIRE rest of the
    // tree — wrapRoot (not splitPanel against a single anchor panel) so it
    // never ends up sharing a slot with just one other panel. `splitPanel`
    // used to target `editor` specifically, which replaced editor's own
    // single-panel group with a 50/50 [simulator, editor] split; once
    // `pinSimulatorWidth` floored that split's simulator side at the device
    // width, the floor could consume the whole (already-narrower) slot and
    // squeeze editor to zero rendered width — e.g. after a hide→show of the
    // simulator, editor would visually vanish even though it was still
    // present in the tree.
    const split = wrapRoot(tree, 'simulator', 'row', 'before')
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
