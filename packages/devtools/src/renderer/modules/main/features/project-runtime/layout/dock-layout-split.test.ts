/**
 * Contract tests for the "split the coarse `debug` dock panel into 5 fine
 * panels" change (TDD — NOT yet implemented).
 *
 * Today `buildDockRegistry()` registers 3 COARSE panels (simulator=native,
 * editor=dom, debug=dom) and the default tree puts the whole BottomDebugPanel
 * in a single `g-debug` tab group. This change splits `debug` into FIVE
 * INDEPENDENT dock panels — wxml / appdata / storage / console / compile —
 * so each is its own dockable unit, while the DEFAULT (FrameTree) mode is
 * untouched.
 *
 * These mirror the topology-agnostic style of `dock-layout.test.ts`: we assert
 * the CONTRACT (which panel ids exist, their kinds, the default grouping +
 * active, fallback safety) by walking whatever tree the implementer produces,
 * NOT by pinning a specific nesting.
 *
 * RED reasons (each should fail for the RIGHT reason, not infra):
 *  - B1: registry still has coarse `debug`, none of the 5 fine ids → assertions
 *    on `registry.get('console')`/`registry.list()` length fail.
 *  - B2: default tree groups `debug`, not the 5 → `collectPanelIds` / tabgroup
 *    lookup fail.
 *  - B3: fallback set is `{simulator,editor,debug}` not the new 7 → restore /
 *    fallback assertions fail.
 *
 * PURE tests: buildDockRegistry / buildDefaultDockTree / buildDockModel are
 * pure data; no React render / jsdom DOM needed.
 */
import { describe, expect, it } from 'vitest'
import {
  serializeLayout,
  validateTree,
} from '@dimina-kit/electron-deck/layout'
import type {
  LayoutNode,
  LayoutTree,
  PanelDescriptor,
  SizeConstraint,
} from '@dimina-kit/electron-deck/layout'
import {
  buildDefaultDockTree,
  buildDockModel,
  buildDockRegistry,
} from './dock-layout'

// ── Tree-walk helpers (topology-agnostic) ────────────────────────────────

/** All panel ids referenced anywhere in the tree (across every tab group). */
function collectPanelIds(node: LayoutNode, into: Set<string> = new Set()): Set<string> {
  if (node.kind === 'tabs') {
    for (const p of node.panels) into.add(p)
  } else {
    for (const child of node.children) collectPanelIds(child, into)
  }
  return into
}

/** Every non-null SizeConstraint present on any split in the tree. */
function collectConstraints(
  node: LayoutNode,
  into: SizeConstraint[] = [],
): SizeConstraint[] {
  if (node.kind === 'split') {
    if (node.constraints) {
      for (const c of node.constraints) {
        if (c !== null) into.push(c)
      }
    }
    for (const child of node.children) collectConstraints(child, into)
  }
  return into
}

/** Every tab group node in the tree. */
function collectTabGroups(
  node: LayoutNode,
  into: Extract<LayoutNode, { kind: 'tabs' }>[] = [],
): Extract<LayoutNode, { kind: 'tabs' }>[] {
  if (node.kind === 'tabs') {
    into.push(node)
  } else {
    for (const child of node.children) collectTabGroups(child, into)
  }
  return into
}

/**
 * Find the split that directly encloses the tab group owning `panelId`, and
 * return that child's constraint plus its siblings' constraints.
 */
function findEnclosingSplitConstraints(
  node: LayoutNode,
  panelId: string,
): { own: SizeConstraint | null; siblings: (SizeConstraint | null)[] } | null {
  if (node.kind === 'tabs') return null
  const idx = node.children.findIndex(
    (c) => c.kind === 'tabs' && c.panels.includes(panelId),
  )
  if (idx !== -1 && node.constraints) {
    const own = node.constraints[idx] ?? null
    const siblings = node.constraints.filter((_, i) => i !== idx)
    return { own, siblings }
  }
  for (const child of node.children) {
    const hit = findEnclosingSplitConstraints(child, panelId)
    if (hit) return hit
  }
  return null
}

// ── Locked contract ──────────────────────────────────────────────────────

/** The five debug-tab panels, in pinned WeChat-DevTools order. */
const DEBUG_PANELS = ['wxml', 'appdata', 'storage', 'console', 'compile'] as const

/** All seven dock panels after the split. */
const KNOWN_7 = new Set<string>(['simulator', 'editor', ...DEBUG_PANELS])

// ── B1. buildDockRegistry: 5 fine panels replace coarse `debug` ──────────

describe('buildDockRegistry — split into 5 fine panels', () => {
  it('registers exactly the 7 dock panels (simulator + editor + 5 debug), no coarse `debug`', () => {
    // Bug guarded: leaving the coarse `debug` panel (or failing to register the
    // 5 fine ones) means console/wxml/appdata/storage/compile can never become
    // their own dockable units.
    const registry = buildDockRegistry()
    const list = registry.list()
    const byId = new Map<string, PanelDescriptor>(list.map((p) => [p.id, p]))

    expect(list).toHaveLength(7)
    expect(new Set(byId.keys())).toEqual(KNOWN_7)

    // The old coarse panel must be gone — it is replaced by the 5 fine ones.
    expect(registry.get('debug')).toBeUndefined()
  })

  it('registers console as a NATIVE panel (main-process WebContentsView overlay, like simulator)', () => {
    // Bug guarded: Console is a main-process DevTools WebContentsView overlaid
    // onto a placeholder rect — exactly like the simulator. Registering it as a
    // `dom` panel would make the dock try to render it as React content and the
    // overlay would have no slot to attach to.
    const registry = buildDockRegistry()
    const consolePanel = registry.get('console')

    expect(consolePanel?.kind).toBe('native')
    expect(
      consolePanel && consolePanel.kind === 'native'
        ? consolePanel.nativeRef.id
        : undefined,
    ).toBe('console')
  })

  it('registers wxml/appdata/storage/compile/editor/simulator as DOM panels', () => {
    // Bug guarded: the four React-content debug tabs must be DOM panels (so
    // renderDomPanel renders them).
    //
    // CONTRACT CHANGE (consolidation): `simulator` is now a DOM panel, not a
    // native one. A bare native slot renders no chrome, but the simulator needs
    // its device/zoom pickers + compile overlays + page-path bar; so
    // `renderDomPanel('simulator')` renders `SimulatorPanel`, which owns the
    // simulator WCV anchor itself. `console` remains the only native panel.
    const registry = buildDockRegistry()

    expect(registry.get('wxml')?.kind).toBe('dom')
    expect(registry.get('appdata')?.kind).toBe('dom')
    expect(registry.get('storage')?.kind).toBe('dom')
    expect(registry.get('compile')?.kind).toBe('dom')

    expect(registry.get('editor')?.kind).toBe('dom')

    expect(registry.get('simulator')?.kind).toBe('dom')
  })
})

// ── B2. buildDefaultDockTree groups the 5 into one tab group ──────────────

describe('buildDefaultDockTree — 5 debug panels grouped on the right', () => {
  it('validates clean against the new 7-panel known set', () => {
    // Bug guarded: a default tree that references an id outside the registry,
    // or that fails the all-constrained guard, would be rejected at restore.
    const tree = buildDefaultDockTree(375)
    expect(validateTree(tree, KNOWN_7)).toEqual([])
  })

  it('references exactly the 7 panels and all appear', () => {
    const tree = buildDefaultDockTree(375)
    expect(collectPanelIds(tree.root)).toEqual(KNOWN_7)
  })

  it('co-locates the 5 debug panels in ONE tab group, in pinned order, active=wxml', () => {
    // Bug guarded: the default appearance must match today (a single right-side
    // debug tab strip). The 5 panels must live in ONE tab group, in WeChat
    // order, with WXML selected first — NOT scattered into 5 separate groups.
    const tree = buildDefaultDockTree(375)
    const groups = collectTabGroups(tree.root)

    const debugGroup = groups.find((g) =>
      DEBUG_PANELS.every((id) => g.panels.includes(id)),
    )
    expect(
      debugGroup,
      'expected one tab group holding all five debug panels',
    ).toBeDefined()

    // Exact order is part of the contract (mirrors the legacy tab strip).
    expect(debugGroup!.panels).toEqual([...DEBUG_PANELS])
    expect(debugGroup!.active).toBe('wxml')
  })

  it('keeps simulator floored at the passed width via a minPx constraint, sibling flexible', () => {
    // Bug guarded: the simulator must never shrink below the device width.
    const tree = buildDefaultDockTree(375)
    const enc = findEnclosingSplitConstraints(tree.root, 'simulator')
    expect(enc).not.toBeNull()
    expect(enc?.own).toEqual({ minPx: 375 })
    expect(enc?.siblings.some((c) => c === null)).toBe(true)
  })

  it('is parametric: a different width lands in the constraint', () => {
    const tree = buildDefaultDockTree(414)
    expect(validateTree(tree, KNOWN_7)).toEqual([])
    const fixedPxValues = collectConstraints(tree.root).map((c) => c.minPx)
    expect(fixedPxValues).toContain(414)
    expect(fixedPxValues).not.toContain(375)
  })
})

// ── B3. buildDockModel restore is fallback-safe with the NEW id set ───────

describe('buildDockModel — fallback safety under the new known-panel set', () => {
  it('serialized=null → builds the default 7-panel tree', () => {
    const model = buildDockModel(null, 375, KNOWN_7)
    const tree = model.get()
    expect(validateTree(tree, KNOWN_7)).toEqual([])
    expect(collectPanelIds(tree.root)).toEqual(KNOWN_7)
  })

  it('a tree referencing all 5 new debug ids restores verbatim (round-trip)', () => {
    // Bug guarded: a persisted layout that the user re-docked (all 5 ids
    // present) must restore exactly, not be discarded as "unknown".
    const W = 320
    const original = buildDefaultDockTree(W)
    const serialized = serializeLayout(original)

    const model = buildDockModel(serialized, 375, KNOWN_7)
    const restored = model.get()

    expect(restored).toEqual(original)
    expect(collectPanelIds(restored.root)).toEqual(KNOWN_7)
    const fixedPxValues = collectConstraints(restored.root).map((c) => c.minPx)
    expect(fixedPxValues).toContain(W)
    expect(fixedPxValues).not.toContain(375)
  })

  it('a tree referencing the OLD coarse `debug` id (now unknown) falls back to default', () => {
    // Bug guarded: a layout persisted BEFORE the split mentions `debug`, which
    // is no longer a known panel. It must be treated as orphan and replaced by
    // the new default — not restored with a dead `debug` group.
    const legacyTree: LayoutTree = {
      version: 1,
      root: {
        kind: 'split',
        id: 'root',
        orientation: 'row',
        sizes: [375, 1],
        constraints: [{ fixedPx: 375 }, null],
        children: [
          { kind: 'tabs', id: 'g-sim', panels: ['simulator'], active: 'simulator' },
          {
            kind: 'split',
            id: 'col-main',
            orientation: 'column',
            sizes: [70, 30],
            children: [
              { kind: 'tabs', id: 'g-editor', panels: ['editor'], active: 'editor' },
              { kind: 'tabs', id: 'g-debug', panels: ['debug'], active: 'debug' },
            ],
          },
        ],
      },
    }
    // sanity: `debug` is the ONLY orphan (so the fallback can't be excused by
    // some other structural defect).
    expect(validateTree(legacyTree, KNOWN_7)).toEqual([
      'orphan panel not in known panel ids: debug',
    ])

    const serialized = serializeLayout(legacyTree)
    const model = buildDockModel(serialized, 375, KNOWN_7)
    const tree = model.get()

    expect(collectPanelIds(tree.root).has('debug')).toBe(false)
    expect(collectPanelIds(tree.root)).toEqual(KNOWN_7)
    expect(validateTree(tree, KNOWN_7)).toEqual([])
  })

  it('malformed json → falls back to the new default (no throw)', () => {
    let model: ReturnType<typeof buildDockModel>
    expect(() => {
      model = buildDockModel('{ not json', 375, KNOWN_7)
    }).not.toThrow()

    const tree = model!.get()
    expect(validateTree(tree, KNOWN_7)).toEqual([])
    expect(collectPanelIds(tree.root)).toEqual(KNOWN_7)
  })
})
