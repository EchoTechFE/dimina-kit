/**
 * WxmlPanel root-expansion contract: the tree's root node renders expanded by
 * default. A collapsed root hides the ENTIRE tree behind a single ▸ row, so
 * the panel would open showing no structure at all — the first level must be
 * visible without a manual expand click. Guards against expand heuristics
 * that key off tag shape (e.g. component-path tags) and silently stop
 * matching the root when the runtime's tag naming changes.
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { WxmlPanel } from './panel-view.js'
import type { WxmlNode } from './types.js'

const TREE: WxmlNode = {
  tagName: 'page',
  attrs: {},
  children: [
    { tagName: 'view', attrs: { class: 'container' }, children: [] },
  ],
}

describe('WxmlPanel: root renders expanded by default', () => {
  it('shows the root children without a manual expand click', () => {
    const { container } = render(<WxmlPanel tree={TREE} />)
    const text = container.textContent ?? ''
    expect(text).toContain('page')
    expect(
      text,
      'the first tree level must be visible on open — a collapsed root leaves the panel blank',
    ).toContain('container')
  })

  it('keeps non-root plain-tag nodes collapsed by default', () => {
    const nested: WxmlNode = {
      tagName: 'page',
      attrs: {},
      children: [
        {
          tagName: 'view',
          attrs: { class: 'outer' },
          children: [{ tagName: 'text', attrs: { class: 'inner-marker' }, children: [] }],
        },
      ],
    }
    const { container } = render(<WxmlPanel tree={nested} />)
    const text = container.textContent ?? ''
    expect(text).toContain('outer')
    expect(
      text,
      'depth-1 plain tags keep the collapsed default — root expansion must not cascade',
    ).not.toContain('inner-marker')
  })
})
