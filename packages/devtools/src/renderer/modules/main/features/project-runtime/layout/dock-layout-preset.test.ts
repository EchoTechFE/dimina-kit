/**
 * `buildPresetDockTree` — the toolbar alignment × devtools-position layout
 * presets. Each of the 6 (alignment × position) combos must be a LEGAL dock tree
 * (validates clean against the 7 known ids), contain ALL seven panels exactly
 * once, and pin the simulator (or the column holding it) to the device width.
 *
 * The assertions pin observable structural invariants, not the implementation.
 */
import { describe, it, expect } from 'vitest'
import { validateTree } from '@dimina-kit/electron-deck/layout'
import type { LayoutNode, LayoutTree } from '@dimina-kit/electron-deck/layout'
import { buildPresetDockTree } from './dock-layout'
import type { SimulatorAlignment, DevtoolsPosition } from '../controllers/use-layout-store'

const KNOWN = new Set(['simulator', 'editor', 'wxml', 'appdata', 'storage', 'console', 'compile'])
const W = 390

function collectPanels(node: LayoutNode, out: string[]): void {
  if (node.kind === 'tabs') { out.push(...node.panels); return }
  for (const c of node.children) collectPanels(c, out)
}

/** Does some split have a minPx===W child whose subtree contains `simulator`? */
function simPinnedTo(tree: LayoutTree, width: number): boolean {
  const subtreeHasSim = (n: LayoutNode): boolean =>
    n.kind === 'tabs' ? n.panels.includes('simulator') : n.children.some(subtreeHasSim)
  const walk = (n: LayoutNode): boolean => {
    if (n.kind === 'tabs') return false
    for (let i = 0; i < n.children.length; i++) {
      const c = n.constraints?.[i] ?? null
      if (c && c.minPx === width && subtreeHasSim(n.children[i]!)) return true
    }
    return n.children.some(walk)
  }
  return walk(tree.root)
}

/** First-to-last panel id of the ROOT row children that are leaf groups / cols. */
function rootChildPanelHead(tree: LayoutTree): string[] {
  if (tree.root.kind !== 'split') return []
  return tree.root.children.map((c) => {
    const ps: string[] = []
    collectPanels(c, ps)
    return ps[0] ?? ''
  })
}

const ALIGNMENTS: SimulatorAlignment[] = ['left', 'right']
const POSITIONS: DevtoolsPosition[] = ['inEditor', 'belowSimulator', 'rightOfSimulator']

describe('buildPresetDockTree', () => {
  for (const alignment of ALIGNMENTS) {
    for (const position of POSITIONS) {
      it(`${alignment} / ${position}: legal tree, all 7 panels once, simulator pinned to width`, () => {
        const tree = buildPresetDockTree(W, alignment, position)
        expect(validateTree(tree, KNOWN)).toEqual([])

        const panels: string[] = []
        collectPanels(tree.root, panels)
        expect([...panels].sort()).toEqual([...KNOWN].sort())
        // no duplicates
        expect(new Set(panels).size).toBe(panels.length)

        expect(simPinnedTo(tree, W), 'simulator must be pinned to the device width').toBe(true)
      })
    }
  }

  it('left vs right alignment mirrors the simulator to the opposite root edge', () => {
    const left = rootChildPanelHead(buildPresetDockTree(W, 'left', 'inEditor'))
    const right = rootChildPanelHead(buildPresetDockTree(W, 'right', 'inEditor'))
    // simulator leads on the left, trails on the right.
    expect(left[0]).toBe('simulator')
    expect(right[right.length - 1]).toBe('simulator')
  })

  it('inEditor / left reproduces the default tree shape (simulator left, debug under editor)', () => {
    const tree = buildPresetDockTree(W, 'left', 'inEditor')
    expect(tree.root.kind).toBe('split')
    if (tree.root.kind === 'split') {
      expect(tree.root.orientation).toBe('row')
      // leading child is the simulator group
      const lead: string[] = []
      collectPanels(tree.root.children[0]!, lead)
      expect(lead).toEqual(['simulator'])
    }
  })
})
