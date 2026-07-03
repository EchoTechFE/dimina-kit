/**
 * WxmlPanel — no refresh button (final-contract.md §9).
 *
 * The panel is now realtime-pushed via the visibility-gated live pipeline
 * (SetActive(true) seeds + subscribes to domReady/domMutated pushes; see
 * simulator-wxml's active-gate contract), so the panel's own "↻ 刷新" button
 * is redundant and must be removed — in BOTH the "no tree yet" empty state and
 * the populated tree state.
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { WxmlPanel } from './wxml-panel'
import type { WxmlNode } from './types.js'

const TREE: WxmlNode = {
  tagName: 'view',
  attrs: {},
  children: [{ tagName: '#text', attrs: {}, children: [], text: 'hello' }],
}

function refreshButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter((b) =>
    (b.textContent ?? '').includes('刷新'),
  )
}

describe('WxmlPanel: no refresh button (final-contract §9)', () => {
  it('does not render a refresh button when a tree is loaded', () => {
    const { container } = render(<WxmlPanel tree={TREE} />)
    expect(refreshButtons(container)).toHaveLength(0)
  })

  it('does not render a refresh button in the "no tree yet" empty state', () => {
    const { container } = render(<WxmlPanel tree={null} />)
    expect(refreshButtons(container)).toHaveLength(0)
  })
})
