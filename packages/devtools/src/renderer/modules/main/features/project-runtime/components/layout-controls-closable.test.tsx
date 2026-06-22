import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { LayoutNode, LayoutTree } from '@dimina-kit/electron-deck/layout'
import { buildDockModel, buildDockRegistry } from '../layout/dock-layout'
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
  const model = buildDockModel(null, 375, new Set())
  const registry = buildDockRegistry()
  const rendered = render(
    <LayoutVisibilityToggles model={model} registry={registry} simPanelWidth={375} />,
  )
  return { model, ...rendered }
}

describe('LayoutVisibilityToggles respects registry closable capability', () => {
  it('cannot hide any built-in debug panel through the debug toolbar toggle', () => {
    const { getByTestId, model } = renderControls()
    const toggle = getByTestId('layout-toolbar-toggle-debug')

    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('title', '调试器固定显示')
    fireEvent.click(toggle)

    const visible = panelIds(model.get())
    for (const panelId of DEBUG_PANELS) {
      expect(visible.has(panelId), `${panelId} must remain visible when closable:false`).toBe(true)
    }
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
