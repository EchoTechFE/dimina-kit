/**
 * Post-consolidation EQUIVALENCE lock: "the default dock tree reproduces the
 * legacy default arrangement" — the single source of truth after the two-path
 * layout (opt-in `dockableMode` flag switching between a hand-rolled
 * `FrameTree` and `<DockView>`) is collapsed to a SINGLE DockView-only layout
 * and the legacy FrameTree / preset / flag code is deleted.
 *
 * Why this file exists separately from `dock-layout-split.test.ts`:
 *  - The split test proved the `debug`→5-panel split CONTRACT (which ids exist,
 *    kinds, the single debug group + active, fixedPx pin, fallback safety).
 *  - This file proves a DIFFERENT thing: that once DockView is the ONE AND ONLY
 *    layout, a FRESH install (no persisted tree) still ships the *exact* legacy
 *    default arrangement. It guards the consolidation from silently degrading
 *    the default UX.
 *
 * Topology-agnostic: we walk the tree rather than pinning nesting, EXCEPT where
 * the contract demands order (row order of sim/editor/debug; the 5-tab strip
 * order). The data layer (`dock-layout.ts`) is NOT changing — only the
 * FrameTree/flag/preset code around it is being deleted — so these must PASS
 * green against the current module today.
 *
 * Overlap note: assertion #2's "fixedPx pin" and "5-tab strip order/active"
 * parts overlap with the split test; they are kept here only as ONE
 * consolidated equivalence assertion (legacy default = sim-left + editor +
 * 5-tab strip) so the equivalence reads end-to-end. The unique value-add is #1
 * (sole canonical default) and #3 (fresh-install === canonical default).
 */
import { describe, expect, it } from 'vitest'
import { validateTree } from '@dimina-kit/electron-deck/layout'
import type { LayoutNode, LayoutTree } from '@dimina-kit/electron-deck/layout'
import { buildDefaultDockTree, buildDockModel } from './dock-layout'

// ── Tree-walk helpers (topology-agnostic) ────────────────────────────────

type TabsNode = Extract<LayoutNode, { kind: 'tabs' }>
type SplitNode = Extract<LayoutNode, { kind: 'split' }>

/** Flat list of every panel id occurrence across every tab group (with dupes). */
function listPanelOccurrences(node: LayoutNode, into: string[] = []): string[] {
  if (node.kind === 'tabs') {
    for (const p of node.panels) into.push(p)
  } else {
    for (const child of node.children) listPanelOccurrences(child, into)
  }
  return into
}

/** Every tab group node in the tree, in traversal order. */
function collectTabGroups(node: LayoutNode, into: TabsNode[] = []): TabsNode[] {
  if (node.kind === 'tabs') {
    into.push(node)
  } else {
    for (const child of node.children) collectTabGroups(child, into)
  }
  return into
}

/**
 * The leading-edge (first) leaf of a subtree: descend the first child of every
 * split until a tab group is reached. Used to assert horizontal row order
 * (which panel region sits on the LEFT) without pinning the exact nesting.
 */
function leadingTabGroup(node: LayoutNode): TabsNode {
  let cur: LayoutNode = node
  while (cur.kind === 'split') cur = cur.children[0]
  return cur
}

/**
 * Flatten the row order of "panel regions" as a reader would see them
 * left→right at the TOP-LEVEL row split: each top-level child contributes the
 * set of panel ids it (transitively) contains, in order. Lets us assert
 * "simulator region precedes the editor/debug region" topology-agnostically.
 */
function topLevelRowRegions(tree: LayoutTree): Set<string>[] {
  const root = tree.root
  if (root.kind !== 'split' || root.orientation !== 'row') {
    // Single region — degenerate, but still answerable.
    return [new Set(listPanelOccurrences(root))]
  }
  return (root as SplitNode).children.map(
    (child) => new Set(listPanelOccurrences(child)),
  )
}

// ── Locked legacy default arrangement ─────────────────────────────────────

/** The five debug-tab panels, in pinned WeChat-DevTools order (legacy strip). */
const DEBUG_PANELS = ['wxml', 'appdata', 'storage', 'console', 'compile'] as const

/** The canonical default dock panels: the editor is intentionally absent. */
const KNOWN_6 = new Set<string>(['simulator', ...DEBUG_PANELS])

/** The full registry of dock panels (incl. the hidden-by-default editor). */
const KNOWN_7 = new Set<string>(['simulator', 'editor', ...DEBUG_PANELS])

const W = 375

// ── #1. The default tree is the SOLE, canonical default ───────────────────

describe('default dock tree — the one and only default (post-consolidation)', () => {
  it('contains EXACTLY the 6 default panels (editor absent), once each, validating clean against the 7-id set', () => {
    // catches: consolidation drops a panel from the default, smuggles an extra
    // panel (e.g. a leftover legacy id) into the default, or duplicates a panel
    // across two groups — any of which means the lone DockView default is NOT
    // the canonical arrangement the product ships on a fresh install. The
    // workbench editor is deliberately NOT among them (debugger-first default;
    // it returns via the toolbar toggle / in-editor preset).
    const tree = buildDefaultDockTree(W)

    const occurrences = listPanelOccurrences(tree.root)
    // exactly 6 occurrences, no duplicates → exactly the 6 known ids, once each.
    expect(occurrences).toHaveLength(6)
    expect(new Set(occurrences)).toEqual(KNOWN_6)
    expect(occurrences).not.toContain('editor')

    // and the engine accepts it against the full 7-id known set (no orphans,
    // no all-fixed split). This is what `buildDockModel` restores against.
    expect(validateTree(tree, KNOWN_7)).toEqual([])
  })
})

// ── #2. Equivalence to the legacy default arrangement ─────────────────────

describe('default dock tree — equivalent to the legacy FrameTree default arrangement', () => {
  it('is simulator-left with the editor hidden, single 5-tab debug strip [wxml,appdata,storage,console,compile] active=wxml, sim pinned to W', () => {
    // catches: consolidation un-pins the simulator width (phone region
    // stretches), reorders the row so the simulator is no longer leading/left,
    // LETS THE EDITOR BACK INTO the default, scatters the debug strip
    // into multiple groups, reorders the 5-tab strip, or changes the initially
    // active debug tab away from WXML — i.e. ANY drift from the default
    // debugger-first UX. (Overlaps the split test on the strip-order + fixedPx
    // facts; kept as ONE consolidated equivalence assertion so the default
    // arrangement reads end-to-end.)
    const tree = buildDefaultDockTree(W)

    // -- ROW ORDER: simulator region is LEADING (left of debug). --
    // This horizontal ordering is the value-add the split test never asserts.
    const regions = topLevelRowRegions(tree)
    expect(regions.length).toBeGreaterThanOrEqual(2)
    const simRegionIdx = regions.findIndex((r) => r.has('simulator'))
    const debugRegionIdx = regions.findIndex((r) =>
      DEBUG_PANELS.some((id) => r.has(id)),
    )
    expect(simRegionIdx).toBe(0)
    expect(simRegionIdx).toBeLessThan(debugRegionIdx)
    // simulator sits ALONE on the leading edge (its own region), not co-mingled.
    expect(regions[0]).toEqual(new Set(['simulator']))

    // -- SIMULATOR floored at W via a minPx constraint on the row split. --
    const root = tree.root as SplitNode
    expect(root.kind).toBe('split')
    expect(root.orientation).toBe('row')
    const simChildIdx = root.children.findIndex(
      (c) => leadingTabGroup(c).panels.includes('simulator'),
    )
    expect(root.constraints?.[simChildIdx]).toEqual({ minPx: W })
    // the sibling region stays weight-sized (null constraint) so it can flex.
    expect(
      root.constraints?.some((c, i) => i !== simChildIdx && c === null),
    ).toBe(true)

    // -- EDITOR hidden in the default (debugger-first; returns via toolbar
    //    toggle / in-editor preset). --
    const allIds = new Set(listPanelOccurrences(tree.root))
    expect(allIds.has('editor')).toBe(false)

    // -- The 5 debug panels co-located in ONE tab group, pinned order, wxml. --
    const groups = collectTabGroups(tree.root)
    const debugGroups = groups.filter((g) =>
      DEBUG_PANELS.some((id) => g.panels.includes(id)),
    )
    expect(debugGroups).toHaveLength(1)
    expect(debugGroups[0].panels).toEqual([...DEBUG_PANELS])
    expect(debugGroups[0].active).toBe('wxml')
  })
})

// ── #3. A fresh install ships the canonical default verbatim ──────────────

describe('fresh install — no persisted tree yields the canonical default', () => {
  it('buildDockModel(null, W, known) === buildDefaultDockTree(W), deeply', () => {
    // catches: the fresh-install path diverging from the canonical default —
    // e.g. the restore fallback seeds a DIFFERENT tree than buildDefaultDockTree
    // (wrong width, different grouping, different active tab), so what actually
    // ships on first launch is NOT the locked default arrangement above. The
    // split test only checks the null case "validates + has 7 panels"; this
    // asserts byte-for-byte equality with the canonical default, which is the
    // proof that "nothing stored ⇒ the canonical default UX".
    const canonical = buildDefaultDockTree(W)
    const fresh = buildDockModel(null, W, KNOWN_7).get()

    expect(fresh).toEqual(canonical)
  })

  it('the fresh-install width is parametric (a different W flows through verbatim)', () => {
    // catches: a hard-coded default width in the fresh-install path that ignores
    // the caller's device width — the simulator would no longer pin to the real
    // device pixel width on first launch.
    const altW = 414
    expect(buildDockModel(null, altW, KNOWN_7).get()).toEqual(
      buildDefaultDockTree(altW),
    )
    // sanity: the two canonical defaults genuinely differ by width, so the
    // equality above is not a vacuous "everything equals everything".
    expect(buildDefaultDockTree(altW)).not.toEqual(buildDefaultDockTree(W))
  })
})
