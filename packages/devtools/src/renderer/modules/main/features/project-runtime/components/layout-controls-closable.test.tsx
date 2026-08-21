import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { LayoutNode, LayoutTree } from '@dimina-kit/electron-deck/layout'
import { serializeLayout } from '@dimina-kit/electron-deck/layout'
import { buildDockModel, buildDockRegistry, buildPresetDockTree } from '../layout/dock-layout'
import { LayoutVisibilityToggles } from './layout-controls'

const DEBUG_PANELS = ['wxml', 'appdata', 'storage', 'console', 'compile'] as const

function panelIds(tree: LayoutTree): Set<string> {
  const ids = new Set<string>()
  function visit(node: LayoutNode): void {
    if (node.kind === 'tabs') {
      node.panels.forEach((id) => ids.add(id))
      return
    }
    node.children.forEach(visit)
  }
  visit(tree.root)
  return ids
}

function renderControls() {
  // Seed the in-editor preset (all 7 panels visible) rather than the canonical
  // default tree, which now ships the editor hidden — these toggles exercise
  // the three-region arrangement (simulator / editor / debug) as a whole.
  const KNOWN_7 = new Set([
    'simulator',
    'editor',
    'wxml',
    'appdata',
    'storage',
    'console',
    'compile',
  ])
  const model = buildDockModel(
    serializeLayout(buildPresetDockTree(375, 'left', 'inEditor')),
    375,
    KNOWN_7,
  )
  const registry = buildDockRegistry()
  const rendered = render(
    <LayoutVisibilityToggles model={model} registry={registry} simPanelWidth={375} />,
  )
  return { model, ...rendered }
}

describe('LayoutVisibilityToggles decouples debug region visibility from per-panel closable', () => {
  it('uses distinct toolbar surfaces for hover and selected states', () => {
    const { getByTestId } = renderControls()
    const selected = getByTestId('layout-toolbar-toggle-simulator')

    expect(selected.className).toContain('hover:[--btn-bg:var(--color-surface-3)]')
    expect(selected.className).toContain('data-[active=true]:[--btn-bg:var(--color-surface-active)]')
    expect(selected.className).not.toContain('opacity-60')
  })

  it('hides the whole debug region in one click even though every debug panel is closable:false', () => {
    const { getByTestId, model } = renderControls()
    const toggle = getByTestId('layout-toolbar-toggle-debug')

    // Three regions visible — the debug toggle is live, not pinned.
    expect(toggle).not.toBeDisabled()

    fireEvent.click(toggle)

    const visible = panelIds(model.get())
    for (const panelId of DEBUG_PANELS) {
      expect(visible.has(panelId), `${panelId} must leave the tree when the region is hidden`).toBe(false)
    }
  })

  it('re-shows the debug region after it was hidden', () => {
    const { getByTestId, model } = renderControls()
    const toggle = getByTestId('layout-toolbar-toggle-debug')

    fireEvent.click(toggle) // hide
    expect(DEBUG_PANELS.some((p) => panelIds(model.get()).has(p))).toBe(false)

    fireEvent.click(toggle) // show
    const visible = panelIds(model.get())
    for (const panelId of DEBUG_PANELS) {
      expect(visible.has(panelId), `${panelId} must rejoin the tree when the region is shown`).toBe(true)
    }
  })

  it('cannot hide the debug region when it is the only visible region', () => {
    const { getByTestId, model } = renderControls()

    // Collapse the other two regions, leaving debug as the sole visible region.
    fireEvent.click(getByTestId('layout-toolbar-toggle-simulator'))
    fireEvent.click(getByTestId('layout-toolbar-toggle-editor'))

    const toggle = getByTestId('layout-toolbar-toggle-debug')
    expect(toggle).toBeDisabled()

    fireEvent.click(toggle)

    const visible = panelIds(model.get())
    expect(DEBUG_PANELS.some((p) => visible.has(p))).toBe(true)
  })

  it.each(['simulator', 'editor'] as const)(
    'keeps the existing user-hide behavior for %s',
    (panelId) => {
      const { getByTestId, model } = renderControls()

      fireEvent.click(getByTestId(`layout-toolbar-toggle-${panelId}`))

      expect(panelIds(model.get()).has(panelId)).toBe(false)
    },
  )
})
