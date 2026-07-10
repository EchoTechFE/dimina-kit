/**
 * Contract tests for the two pure dock-layout helpers `reopenPanel` and
 * `listPanelVisibility` in `dock-layout.ts`.
 *
 * Topology-agnostic: like the sibling `dock-layout-split.test.ts` /
 * `default-dock-tree-equivalence.test.ts`, we set up scenarios from
 * `buildDefaultDockTree(W)` + `closePanel(...)` and assert the CONTRACT by
 * walking whatever tree is produced — never pinning a specific nesting.
 * `findGroupById` / `collectPanelIds` are NOT exported by the engine, so we
 * walk the tree ourselves below.
 *
 * The two helpers under test:
 *
 *   A. reopenPanel(tree, panelId, simPanelWidth): LayoutTree
 *      Re-inserts a currently-CLOSED panel at a sensible default-aligned spot.
 *      - debug panels land beside a surviving default mate (same group);
 *      - all-mates-gone → its own group is fine, tree still validates;
 *      - simulator gets re-pinned to `minPx === simPanelWidth`;
 *      - already-present id → returns an equal tree (idempotent, no dup, no throw);
 *      - never drops an already-present panel; always validates clean.
 *
 *   B. listPanelVisibility(tree, registry): { id, title, open }[]
 *      One entry per REGISTERED panel, in registry order, `open` iff present in
 *      the tree.
 */
import { describe, expect, it } from 'vitest'
import {
  closePanel,
  serializeLayout,
  validateTree,
} from '@dimina-kit/electron-deck/layout'
import type { LayoutNode, LayoutTree } from '@dimina-kit/electron-deck/layout'
import {
  buildDefaultDockTree,
  buildDockRegistry,
  listPanelVisibility,
  reopenPanel,
} from './dock-layout'

// ── Tree-walk helpers (engine does not export these) ──────────────────────

type TabsNode = Extract<LayoutNode, { kind: 'tabs' }>

/** All panel ids referenced anywhere in the tree (across every tab group). */
function collectPanelIds(node: LayoutNode, into: Set<string> = new Set()): Set<string> {
  if (node.kind === 'tabs') {
    for (const p of node.panels) into.add(p)
  } else {
    for (const child of node.children) collectPanelIds(child, into)
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

/** The tab-group id that holds `panelId`, or null if it is not in any group. */
function groupIdOf(tree: LayoutTree, panelId: string): string | null {
  for (const g of collectTabGroups(tree.root)) {
    if (g.panels.includes(panelId)) return g.id
  }
  return null
}

/**
 * The split node whose DIRECT child is the tab group holding `panelId` (i.e.
 * `panelId`'s immediate parent split), or null if `panelId` is the tree root's
 * sole group (no parent split) or is absent entirely.
 */
function parentSplitOfGroupHolding(node: LayoutNode, panelId: string): Extract<LayoutNode, { kind: 'split' }> | null {
  if (node.kind === 'tabs') return null
  for (const child of node.children) {
    if (child.kind === 'tabs' && child.panels.includes(panelId)) return node
    const hit = parentSplitOfGroupHolding(child, panelId)
    if (hit) return hit
  }
  return null
}

/**
 * Is `simulator` floored via a `minPx === W` constraint? Walk every split:
 * for each child index i whose subtree CONTAINS `simulator`, check whether that
 * split carries `constraints[i].minPx === W`.
 */
function simulatorPinnedTo(node: LayoutNode, w: number): boolean {
  if (node.kind === 'tabs') return false
  if (node.constraints) {
    for (let i = 0; i < node.children.length; i++) {
      if (collectPanelIds(node.children[i]).has('simulator')) {
        const c = node.constraints[i]
        if (c !== null && c !== undefined && c.minPx === w) return true
      }
    }
  }
  return node.children.some((child) => simulatorPinnedTo(child, w))
}

// ── Locked contract ───────────────────────────────────────────────────────

const DEBUG_PANELS = ['wxml', 'appdata', 'storage', 'console', 'compile'] as const
const KNOWN_7 = new Set<string>(['simulator', 'editor', ...DEBUG_PANELS])
const W = 375

// ──────────────────────────────────────────────────────────────────────────
// A. reopenPanel
// ──────────────────────────────────────────────────────────────────────────

describe('reopenPanel — re-insert a closed panel at a default-aligned spot', () => {
  it('A1: reopening a debug panel lands it beside a surviving default mate', () => {
    // close `storage`, then reopen → it must rejoin the SAME group that still
    // holds its default mates (wxml/console/...), not float off on its own while
    // mates are present.
    const closed = closePanel(buildDefaultDockTree(W), 'storage')
    expect(collectPanelIds(closed.root).has('storage')).toBe(false)
    const mateGroupId = groupIdOf(closed, 'wxml')
    expect(mateGroupId).not.toBeNull()

    const reopened = reopenPanel(closed, 'storage', W)

    expect(collectPanelIds(reopened.root).has('storage')).toBe(true)
    expect(groupIdOf(reopened, 'storage')).toBe(mateGroupId)
    expect(groupIdOf(reopened, 'console')).toBe(mateGroupId)
  })

  it('A2: reopening a debug panel when ALL its mates are gone → present in some group, validates', () => {
    let tree = buildDefaultDockTree(W)
    for (const id of DEBUG_PANELS) {
      if (id !== 'storage') tree = closePanel(tree, id)
    }
    // storage is now the SOLE survivor of the debug strip; close it too.
    tree = closePanel(tree, 'storage')
    expect(collectPanelIds(tree.root).has('storage')).toBe(false)
    // none of its default mates remain anywhere in the tree.
    for (const id of DEBUG_PANELS) {
      expect(collectPanelIds(tree.root).has(id)).toBe(false)
    }

    const reopened = reopenPanel(tree, 'storage', W)

    expect(collectPanelIds(reopened.root).has('storage')).toBe(true)
    expect(groupIdOf(reopened, 'storage')).not.toBeNull()
    expect(validateTree(reopened, KNOWN_7)).toEqual([])
  })

  it('A3: reopening `editor` after it was closed → present again, validates', () => {
    const closed = closePanel(buildDefaultDockTree(W), 'editor')
    expect(collectPanelIds(closed.root).has('editor')).toBe(false)

    const reopened = reopenPanel(closed, 'editor', W)

    expect(collectPanelIds(reopened.root).has('editor')).toBe(true)
    expect(groupIdOf(reopened, 'editor')).not.toBeNull()
    expect(validateTree(reopened, KNOWN_7)).toEqual([])
  })

  it('A3b: regression — reopening `editor` keeps the debug region as ONE group, never splitting wxml off from its mates', () => {
    // Reproduces the reported bug: hide editor, then show it again. All five
    // debug panels must still share the SAME tab group afterward — not have
    // wxml peeled off into its own group beside editor while
    // appdata/storage/console/compile are left behind in the original group.
    const closed = closePanel(buildDefaultDockTree(W), 'editor')
    const debugGroupIdBefore = groupIdOf(closed, 'wxml')
    expect(debugGroupIdBefore).not.toBeNull()

    const reopened = reopenPanel(closed, 'editor', W)

    const debugGroupIdAfter = groupIdOf(reopened, 'wxml')
    expect(debugGroupIdAfter).not.toBeNull()
    for (const id of DEBUG_PANELS) {
      expect(groupIdOf(reopened, id)).toBe(debugGroupIdAfter)
    }
    expect(validateTree(reopened, KNOWN_7)).toEqual([])
  })

  it('A4: reopening `simulator` re-pins it to minPx === simPanelWidth', () => {
    const closed = closePanel(buildDefaultDockTree(W), 'simulator')
    expect(collectPanelIds(closed.root).has('simulator')).toBe(false)

    const reopened = reopenPanel(closed, 'simulator', W)

    expect(collectPanelIds(reopened.root).has('simulator')).toBe(true)
    // somewhere a split has a child whose subtree contains `simulator` and whose
    // matching constraint is `{ minPx: W }`.
    expect(simulatorPinnedTo(reopened.root, W)).toBe(true)
    expect(validateTree(reopened, KNOWN_7)).toEqual([])
  })

  it('A4b: the simulator pin is parametric (a different width flows through)', () => {
    const altW = 414
    const closed = closePanel(buildDefaultDockTree(altW), 'simulator')
    const reopened = reopenPanel(closed, 'simulator', altW)

    expect(simulatorPinnedTo(reopened.root, altW)).toBe(true)
    expect(simulatorPinnedTo(reopened.root, W)).toBe(false)
  })

  it('A4c: regression — reopening `simulator` sits it beside the ENTIRE rest of the tree, never squeezing a sibling to zero width', () => {
    // Reproduces the reported bug: hide simulator, then show it again. Editor
    // (and every debug panel) must still be reachable as full peers of
    // simulator afterward — not merged into a 50/50 split with just ONE of
    // them, which is what let the device-width floor swallow that one
    // sibling's entire slot and render it as if it had vanished.
    const closed = closePanel(buildDefaultDockTree(W), 'simulator')
    const restBefore = collectPanelIds(closed.root) // editor + 5 debug panels, no simulator

    const reopened = reopenPanel(closed, 'simulator', W)

    const parentSplit = parentSplitOfGroupHolding(reopened.root, 'simulator')
    expect(parentSplit).not.toBeNull()
    // Every panel that existed before the reopen must live in the sibling
    // side(s) of simulator's immediate parent split — i.e. simulator was
    // attached beside the WHOLE prior tree, not nested inside a slice of it.
    const siblingPanelIds = new Set<string>()
    for (const child of parentSplit!.children) {
      if (child.kind === 'tabs' && child.panels.includes('simulator')) continue
      collectPanelIds(child, siblingPanelIds)
    }
    expect(siblingPanelIds).toEqual(restBefore)
    expect(validateTree(reopened, KNOWN_7)).toEqual([])
  })

  it('A5: idempotent — reopening an ALREADY-present id returns an equal tree, no throw, no dup', () => {
    const tree = buildDefaultDockTree(W) // `storage` is already present
    let reopened!: LayoutTree
    expect(() => {
      reopened = reopenPanel(tree, 'storage', W)
    }).not.toThrow()

    // serialize-and-compare: structurally identical to the input.
    expect(serializeLayout(reopened)).toEqual(serializeLayout(tree))
    // and definitely no duplicate occurrence of `storage`.
    const occurrences = collectTabGroups(reopened.root)
      .flatMap((g) => g.panels)
      .filter((p) => p === 'storage')
    expect(occurrences).toHaveLength(1)
  })

  it('A6: preservation — reopening one panel never drops an already-present panel', () => {
    const closed = closePanel(buildDefaultDockTree(W), 'appdata')
    const before = collectPanelIds(closed.root)
    expect(before.has('appdata')).toBe(false)

    const reopened = reopenPanel(closed, 'appdata', W)
    const after = collectPanelIds(reopened.root)

    // after === before ∪ {reopened id}
    expect(after).toEqual(new Set([...before, 'appdata']))
  })

  it('A7: the result always validates clean against the 7 known ids', () => {
    for (const id of [...KNOWN_7]) {
      const closed = closePanel(buildDefaultDockTree(W), id)
      const reopened = reopenPanel(closed, id, W)
      expect(
        validateTree(reopened, KNOWN_7),
        `reopening ${id} should validate clean`,
      ).toEqual([])
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────
// B. listPanelVisibility
// ──────────────────────────────────────────────────────────────────────────

describe('listPanelVisibility — one entry per registered panel, open iff present', () => {
  it('B1: full default tree → all 7 open, titles match the registry, in registry order', () => {
    const registry = buildDockRegistry()
    const tree = buildDefaultDockTree(W)

    const list = listPanelVisibility(tree, registry)

    expect(list).toEqual([
      { id: 'simulator', title: 'Simulator', open: true },
      { id: 'editor', title: 'Editor', open: true },
      { id: 'wxml', title: 'WXML', open: true },
      { id: 'appdata', title: 'AppData', open: true },
      { id: 'storage', title: 'Storage', open: true },
      { id: 'console', title: 'Console', open: true },
      { id: 'compile', title: '编译', open: true },
    ])
  })

  it('B2: after closing `storage` → its entry is open:false, all others open:true', () => {
    const registry = buildDockRegistry()
    const tree = closePanel(buildDefaultDockTree(W), 'storage')

    const list = listPanelVisibility(tree, registry)

    for (const entry of list) {
      expect(entry.open).toBe(entry.id !== 'storage')
    }
    const storage = list.find((e) => e.id === 'storage')
    expect(storage).toEqual({ id: 'storage', title: 'Storage', open: false })
  })

  it('B3: length always equals the registry size (7), regardless of tree state', () => {
    const registry = buildDockRegistry()
    expect(registry.list()).toHaveLength(7)

    expect(listPanelVisibility(buildDefaultDockTree(W), registry)).toHaveLength(7)

    const trimmed = closePanel(
      closePanel(buildDefaultDockTree(W), 'storage'),
      'appdata',
    )
    expect(listPanelVisibility(trimmed, registry)).toHaveLength(7)
    // registry order is stable: ids match the registry's own ordering.
    expect(listPanelVisibility(trimmed, registry).map((e) => e.id)).toEqual(
      registry.list().map((p) => p.id),
    )
  })
})
