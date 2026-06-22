/**
 * Wiring test — `restoreTreeOrDefault` heals non-positive FLEXIBLE weights
 * (via `sanitizeFlexibleWeights`) before handing the tree to the model.
 *
 * Without healing, `restoreTreeOrDefault` would return a parsed tree VERBATIM
 * once it round-trips + validates; a persisted tree with a flexible pane
 * collapsed to weight 0 (a structurally-LEGAL state — `validateTree` only
 * rejects NON-FINITE sizes, not 0) would survive un-healed and the pane would
 * restore as a 0-share sliver. `buildDockModel` heals that weight to > 0.
 *
 * The bad tree is built from `buildDefaultDockTree(375)` with ONE flexible
 * child's weight zeroed, so it stays structurally legal + references ONLY the 7
 * known ids (otherwise `restoreTreeOrDefault` would fall back to the default and
 * we'd never reach the heal point).
 */
import { describe, expect, it } from 'vitest'
import { serializeLayout, validateTree } from '@dimina-kit/electron-deck/layout'
import type { LayoutNode, LayoutTree } from '@dimina-kit/electron-deck/layout'
import { buildDefaultDockTree, buildDockModel } from './dock-layout'

// The seven known dock panel ids (must match dock-layout's registry).
const KNOWN_7 = new Set<string>([
  'simulator',
  'editor',
  'wxml',
  'appdata',
  'storage',
  'console',
  'compile',
])
const W = 375

// ── helpers ─────────────────────────────────────────────────────────────────

/** Locate a split by id and return the weight at child index `i`. */
function weightOf(tree: LayoutTree, splitId: string, i: number): number {
  let found: number | undefined
  const walk = (n: LayoutNode): void => {
    if (n.kind !== 'split') return
    if (n.id === splitId) found = n.sizes[i]
    n.children.forEach(walk)
  }
  walk(tree.root)
  if (found === undefined) throw new Error(`split ${splitId} not found`)
  return found
}

/**
 * Deep clone of the default tree with the FLEXIBLE main column's weight zeroed.
 *
 * `buildDefaultDockTree`'s root row split is `[g-sim(minPx), col-main(null)]`
 * with sizes `[1, 6]`. We zero child index 1 (the flexible `col-main`) — a
 * legal-but-collapsed flexible pane. (We deliberately do NOT touch the px-sized
 * sim child, which is out of the heal's scope.)
 */
function defaultTreeWithZeroedMainColumn(): LayoutTree {
  const t = JSON.parse(JSON.stringify(buildDefaultDockTree(W))) as LayoutTree
  const root = t.root as Extract<LayoutNode, { kind: 'split' }>
  // sanity: the structure we depend on is what we think it is.
  if (root.kind !== 'split' || root.id !== 'root') {
    throw new Error('default tree root is not the expected row split')
  }
  ;(root.sizes as number[])[1] = 0 // collapse the flexible main column.
  return t
}

// ── the wiring assertion ──────────────────────────────────────────────────────

describe('buildDockModel — heals 0-weight flexible panes on restore', () => {
  it('restores a legal tree whose flexible main-column weight is 0 with that weight healed to > 0', () => {
    const bad = defaultTreeWithZeroedMainColumn()

    // PRECONDITION: the bad tree is STRUCTURALLY LEGAL (validateTree clean) and
    // references only the 7 known ids — so restore reaches the heal point and
    // does NOT bail to the default. (A 0 weight is a finite size, hence legal.)
    expect(validateTree(bad, KNOWN_7)).toEqual([])
    expect(weightOf(bad, 'root', 1)).toBe(0)

    const serialized = serializeLayout(bad)
    const model = buildDockModel(serialized, W, KNOWN_7)
    const restored = model.get()

    // The flexible main column is healed to a positive weight...
    expect(weightOf(restored, 'root', 1)).toBeGreaterThan(0)
    // ...the px-sized simulator child weight is untouched (out of heal scope)...
    expect(weightOf(restored, 'root', 0)).toBe(weightOf(bad, 'root', 0))
    // ...and the healed tree is still valid.
    expect(validateTree(restored, KNOWN_7)).toEqual([])
  })
})

// ── forced-persistence wiring (PURE-LOGIC PROXY) ─────────────────────────────
//
// CONTRACT: on mount, `DockableLayout` compares the tree `buildDockModel`
// produced (serialized) against the ORIGINAL persisted string; when they DIFFER
// (i.e. a heal rewrote a bad value), it must persist the healed string back,
// overwriting the corrupt one — so the bad value is repaired on disk, not just
// in memory.
//
// WEAKENED ASSERTION (documented): the real `onPersistTree` call happens inside
// the React `DockableLayout` component, which pulls in view-anchor / DockView /
// native slots and is impractical to render in jsdom. So instead of asserting
// the side effect, this proves the PREDICATE that gates it: the healed tree
// re-serializes to a string that is `!==` the persisted input. That `!==` is
// EXACTLY the condition the mount-time "diff ⇒ persist" branch keys off of, so a
// green here guarantees that branch FIRES. The actual `onPersistTree(arg)`
// dispatch + its argument are left to the component layer / real-app e2e.
describe('buildDockModel — healed output differs from the persisted bad string (persist trigger)', () => {
  it('re-serializing the healed tree differs from the original 0-weight string', () => {
    const bad = defaultTreeWithZeroedMainColumn()
    const persisted = serializeLayout(bad)

    const restored = buildDockModel(persisted, W, KNOWN_7).get()
    const healed = serializeLayout(restored)

    // The heal changed the content => the mount-time "serialized !== persisted"
    // branch (which calls onPersistTree) is taken.
    expect(healed).not.toBe(persisted)

    // sanity: a tree that was ALREADY healthy serializes back UNCHANGED, so the
    // persist branch would NOT fire spuriously on a clean restore.
    const healthy = serializeLayout(buildDefaultDockTree(W))
    const healthyRestored = serializeLayout(
      buildDockModel(healthy, W, KNOWN_7).get(),
    )
    expect(healthyRestored).toBe(healthy)
  })
})
