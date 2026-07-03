/**
 * Contract tests for the self-heal `buildDockModel` performs when restoring
 * a PERSISTED (legal) tree that is missing one or more built-in debug panels.
 *
 * Real downstream bug: an older build let the debug tab group be closed down
 * to just `['appdata','storage']` — `wxml`/`console`/`compile` fell out of the
 * persisted tree and no restart brought them back, because `buildDockModel`
 * previously trusted a structurally-legal restored tree verbatim. The heal
 * under test detects a PARTIAL debug strip (>=1 but <5 of the five built-in
 * debug panels present) and re-inserts the missing ones into the surviving
 * group, while leaving a legitimately fully-hidden debug strip (0 of 5, e.g.
 * the toolbar's "debugger" toggle) untouched.
 *
 * Topology is pinned here (unlike the sibling `dock-layout-reopen.test.ts`,
 * which is topology-agnostic) because the primary case reproduces the exact
 * persisted JSON from the downstream bug report and asserts structural
 * details (group identity, active tab, sibling order, root sizes/constraints)
 * that only make sense against that concrete shape.
 */
import { describe, expect, it } from 'vitest'
import { serializeLayout, validateTree } from '@dimina-kit/electron-deck/layout'
import type { LayoutNode, LayoutTree } from '@dimina-kit/electron-deck/layout'
import { buildDefaultDockTree, buildDockModel } from './dock-layout'

type TabsNode = Extract<LayoutNode, { kind: 'tabs' }>
type SplitNode = Extract<LayoutNode, { kind: 'split' }>

// The five built-in debug panels the heal is responsible for.
const DEBUG_PANELS = ['wxml', 'appdata', 'storage', 'console', 'compile'] as const
const KNOWN_7 = new Set<string>(['simulator', 'editor', ...DEBUG_PANELS])
const W = 423

// ── tree-walk helpers (mirrors dock-layout-reopen.test.ts) ────────────────

function collectPanelIds(node: LayoutNode, into: Set<string> = new Set()): Set<string> {
  if (node.kind === 'tabs') {
    for (const p of node.panels) into.add(p)
  } else {
    for (const child of node.children) collectPanelIds(child, into)
  }
  return into
}

function collectTabGroups(node: LayoutNode, into: TabsNode[] = []): TabsNode[] {
  if (node.kind === 'tabs') {
    into.push(node)
  } else {
    for (const child of node.children) collectTabGroups(child, into)
  }
  return into
}

function groupIdOf(tree: LayoutTree, panelId: string): string | null {
  for (const g of collectTabGroups(tree.root)) {
    if (g.panels.includes(panelId)) return g.id
  }
  return null
}

function findTabsById(tree: LayoutTree, id: string): TabsNode | null {
  return collectTabGroups(tree.root).find((g) => g.id === id) ?? null
}

function findSplitById(node: LayoutNode, id: string): SplitNode | null {
  if (node.kind === 'tabs') return null
  if (node.id === id) return node
  for (const child of node.children) {
    const found = findSplitById(child, id)
    if (found) return found
  }
  return null
}

// ── the real downstream bug-report tree ────────────────────────────────────
//
// debug group is down to `['appdata','storage']` — wxml/console/compile were
// dismissed at some point in the past and never came back on restart.
const BUGGY_PERSISTED_JSON = JSON.stringify({
  version: 1,
  root: {
    kind: 'split',
    id: 'root',
    orientation: 'row',
    children: [
      { kind: 'tabs', id: 'g-sim', panels: ['simulator'], active: 'simulator' },
      {
        kind: 'split',
        id: 'col-main',
        orientation: 'column',
        children: [
          { kind: 'tabs', id: 'g-editor', panels: ['editor'], active: 'editor' },
          { kind: 'tabs', id: 'g-debug', panels: ['appdata', 'storage'], active: 'appdata' },
        ],
        sizes: [57.498, 42.502],
      },
    ],
    sizes: [1, 6],
    constraints: [{ minPx: 423 }, null],
  },
})

describe('buildDockModel — heals a partially-emptied debug tab group on restore', () => {
  it('re-inserts wxml/console/compile beside the surviving appdata/storage, preserving order/active/siblings/root sizing', () => {
    const model = buildDockModel(BUGGY_PERSISTED_JSON, W, KNOWN_7)
    const restored = model.get()

    // all five built-in debug panels are present after restore.
    for (const id of DEBUG_PANELS) {
      expect(collectPanelIds(restored.root).has(id), `${id} should be healed back in`).toBe(true)
    }

    // they all live in the SAME tab group (the one that held the survivors).
    const survivorGroupId = groupIdOf(restored, 'appdata')
    expect(survivorGroupId).not.toBeNull()
    for (const id of DEBUG_PANELS) {
      expect(groupIdOf(restored, id)).toBe(survivorGroupId)
    }

    // the surviving pair's relative order is unchanged (appdata before storage).
    const debugGroup = findTabsById(restored, survivorGroupId as string) as TabsNode
    const iAppdata = debugGroup.panels.indexOf('appdata')
    const iStorage = debugGroup.panels.indexOf('storage')
    expect(iAppdata).toBeGreaterThanOrEqual(0)
    expect(iStorage).toBeGreaterThanOrEqual(0)
    expect(iAppdata).toBeLessThan(iStorage)

    // the active tab is untouched.
    expect(debugGroup.active).toBe('appdata')

    // sibling groups (simulator, editor) are not touched by the heal.
    const simGroup = findTabsById(restored, 'g-sim')
    expect(simGroup).toEqual({ kind: 'tabs', id: 'g-sim', panels: ['simulator'], active: 'simulator' })
    const editorGroup = findTabsById(restored, 'g-editor')
    expect(editorGroup).toEqual({ kind: 'tabs', id: 'g-editor', panels: ['editor'], active: 'editor' })

    // root sizes/constraints (the pinned simulator column) survive the heal untouched.
    const root = findSplitById(restored.root, 'root') as SplitNode
    expect(root.sizes).toEqual([1, 6])
    expect(root.constraints).toEqual([{ minPx: 423 }, null])

    expect(validateTree(restored, KNOWN_7)).toEqual([])
  })
})

describe('buildDockModel — heal is version-ramp aware (a newly-added debug panel is also backfilled)', () => {
  it('backfills `compile` into an older persisted tree whose debug group predates it', () => {
    const preCompileJson = JSON.stringify({
      version: 1,
      root: {
        kind: 'split',
        id: 'root',
        orientation: 'row',
        children: [
          { kind: 'tabs', id: 'g-sim', panels: ['simulator'], active: 'simulator' },
          {
            kind: 'split',
            id: 'col-main',
            orientation: 'column',
            children: [
              { kind: 'tabs', id: 'g-editor', panels: ['editor'], active: 'editor' },
              {
                kind: 'tabs',
                id: 'g-debug',
                panels: ['wxml', 'appdata', 'storage', 'console'],
                active: 'wxml',
              },
            ],
            sizes: [50, 50],
          },
        ],
        sizes: [1, 6],
        constraints: [{ minPx: W }, null],
      },
    })

    const restored = buildDockModel(preCompileJson, W, KNOWN_7).get()

    expect(collectPanelIds(restored.root).has('compile')).toBe(true)
    expect(groupIdOf(restored, 'compile')).toBe(groupIdOf(restored, 'wxml'))
    expect(validateTree(restored, KNOWN_7)).toEqual([])
  })
})

describe('buildDockModel — a fully-hidden debug strip is a legitimate state and is left alone', () => {
  it('zero of five debug panels present (debugger toggled off) stays at zero after restore', () => {
    const noDebugJson = JSON.stringify({
      version: 1,
      root: {
        kind: 'split',
        id: 'root',
        orientation: 'row',
        children: [
          { kind: 'tabs', id: 'g-sim', panels: ['simulator'], active: 'simulator' },
          { kind: 'tabs', id: 'g-editor', panels: ['editor'], active: 'editor' },
        ],
        sizes: [1, 6],
        constraints: [{ minPx: W }, null],
      },
    })

    const restored = buildDockModel(noDebugJson, W, KNOWN_7).get()

    for (const id of DEBUG_PANELS) {
      expect(collectPanelIds(restored.root).has(id), `${id} must not be reinstated`).toBe(false)
    }
    expect(collectPanelIds(restored.root)).toEqual(new Set(['simulator', 'editor']))
  })
})

describe('buildDockModel — a fully-populated debug strip round-trips unchanged', () => {
  it('the default tree, serialized then restored, is unaffected by the heal', () => {
    const original = buildDefaultDockTree(W)
    const serialized = serializeLayout(original)

    const restored = buildDockModel(serialized, W, KNOWN_7).get()

    expect(serializeLayout(restored)).toBe(serialized)
  })
})

describe('buildDockModel — the heal never reinstates a panel outside its own scope', () => {
  it('a tree missing `editor` (user-hidden independently) stays without editor after the debug heal', () => {
    const missingEditorJson = JSON.stringify({
      version: 1,
      root: {
        kind: 'split',
        id: 'root',
        orientation: 'row',
        children: [
          { kind: 'tabs', id: 'g-sim', panels: ['simulator'], active: 'simulator' },
          {
            kind: 'tabs',
            id: 'g-debug',
            panels: ['wxml', 'appdata', 'storage', 'console', 'compile'],
            active: 'wxml',
          },
        ],
        sizes: [1, 6],
        constraints: [{ minPx: W }, null],
      },
    })

    const restored = buildDockModel(missingEditorJson, W, KNOWN_7).get()

    expect(collectPanelIds(restored.root).has('editor')).toBe(false)
    for (const id of DEBUG_PANELS) {
      expect(collectPanelIds(restored.root).has(id)).toBe(true)
    }
  })
})

describe('buildDockModel — the healed tree is a fixed point (idempotent under re-restore)', () => {
  it('re-feeding the healed serialization back in produces the identical tree again', () => {
    const firstPass = buildDockModel(BUGGY_PERSISTED_JSON, W, KNOWN_7).get()
    const healedSerialized = serializeLayout(firstPass)

    const secondPass = buildDockModel(healedSerialized, W, KNOWN_7).get()

    expect(serializeLayout(secondPass)).toBe(healedSerialized)
  })
})
