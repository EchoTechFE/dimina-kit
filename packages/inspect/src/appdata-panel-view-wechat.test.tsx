/**
 * AppDataPanel — WeChat DevTools parity.
 *
 * A Pages sidebar drives a single merged data tree per page, replacing the
 * old top bridge-tab bar and the one-JSON-card-per-component-path layout.
 * Every active bridge's `entries[bridgeId]` component objects are
 * shallow-merged (insertion order, later wins) into one root object and
 * rendered as a collapsible tree: the root and its top-level keys are always
 * visible, nested object/array nodes start collapsed, and a toolbar can
 * expand or collapse everything at once. Editing behavior (checkboxes,
 * inline text/number edit, data-path targeting, undo/redo) is covered
 * separately in appdata-tree-edit.test.tsx.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { AppDataPanel, type AppDataPanelState as AppDataState } from './appdata-panel-view.js'

function makeState(overrides: Partial<AppDataState> = {}): AppDataState {
  return {
    bridges: [{ id: 'b1', pagePath: 'pages/index/index' }],
    activeBridgeId: 'b1',
    entries: { b1: { 'pages/index/index': { count: 1 } } },
    ...overrides,
  }
}

describe('AppDataPanel: Pages sidebar', () => {
  it('renders a Pages sidebar with one item even for a single bridge', () => {
    const { getByTestId, getAllByTestId } = render(
      <AppDataPanel state={makeState()} onSelectBridge={vi.fn()} />,
    )
    const sidebar = getByTestId('appdata-pages')
    expect(sidebar.textContent).toContain('Pages')
    expect(getAllByTestId('appdata-page-item')).toHaveLength(1)
  })

  it('labels each page item by pagePath, falling back to the bridge id when pagePath is null', () => {
    const state = makeState({
      bridges: [
        { id: 'b1', pagePath: '/pages/index/index' },
        { id: 'b2', pagePath: null },
      ],
      activeBridgeId: 'b1',
      entries: {
        b1: { 'pages/index/index': { count: 1 } },
        b2: { 'pages/detail/detail': { count: 2 } },
      },
    })
    const { getAllByTestId } = render(<AppDataPanel state={state} onSelectBridge={vi.fn()} />)
    const labels = getAllByTestId('appdata-page-item').map(el => (el.textContent ?? '').trim())
    expect(labels).toContain('/pages/index/index')
    expect(labels).toContain('b2')
  })

  it('marks the active bridge row aria-selected=true and the rest aria-selected=false', () => {
    const state = makeState({
      bridges: [
        { id: 'b1', pagePath: '/pages/index/index' },
        { id: 'b2', pagePath: '/pages/detail/detail' },
      ],
      activeBridgeId: 'b2',
      entries: {
        b1: { 'pages/index/index': { count: 1 } },
        b2: { 'pages/detail/detail': { count: 2 } },
      },
    })
    const { getAllByTestId } = render(<AppDataPanel state={state} onSelectBridge={vi.fn()} />)
    const items = getAllByTestId('appdata-page-item')
    const b1Item = items.find(el => (el.textContent ?? '').trim() === '/pages/index/index')!
    const b2Item = items.find(el => (el.textContent ?? '').trim() === '/pages/detail/detail')!
    expect(b1Item.getAttribute('aria-selected')).toBe('false')
    expect(b2Item.getAttribute('aria-selected')).toBe('true')
  })

  it('calls onSelectBridge with the clicked bridge id', () => {
    const state = makeState({
      bridges: [
        { id: 'b1', pagePath: '/pages/index/index' },
        { id: 'b2', pagePath: '/pages/detail/detail' },
      ],
      activeBridgeId: 'b1',
      entries: {
        b1: { 'pages/index/index': { count: 1 } },
        b2: { 'pages/detail/detail': { count: 2 } },
      },
    })
    const onSelectBridge = vi.fn()
    const { getAllByTestId } = render(<AppDataPanel state={state} onSelectBridge={onSelectBridge} />)
    const b2Item = getAllByTestId('appdata-page-item').find(
      el => (el.textContent ?? '').trim() === '/pages/detail/detail',
    )!
    fireEvent.click(b2Item)
    expect(onSelectBridge).toHaveBeenCalledWith('b2')
  })
})

describe('AppDataPanel: merged data tree', () => {
  it('shallow-merges every component entry for the active bridge into one tree, later entries winning on key conflicts', () => {
    const state = makeState({
      entries: {
        b1: {
          'pages/index/index': { count: 1, shared: 'first' },
          'components/foo/foo': { visible: true, shared: 'second' },
        },
      },
    })
    const { getByTestId } = render(<AppDataPanel state={state} onSelectBridge={vi.fn()} />)
    const tree = getByTestId('appdata-tree')
    expect(tree.textContent).toContain('count')
    expect(tree.textContent).toContain('visible')
    expect(tree.textContent).toContain('second')
  })

  it('renders exactly one merged tree per bridge, not one card per component path', () => {
    const state = makeState({
      entries: {
        b1: {
          'pages/index/index': { count: 1 },
          'components/foo/foo': { visible: true },
        },
      },
    })
    const { container } = render(<AppDataPanel state={state} onSelectBridge={vi.fn()} />)
    const bridgeContainer = container.querySelector('[data-bridge-id="b1"]') as HTMLElement
    expect(bridgeContainer.querySelectorAll('[data-testid="appdata-tree"]')).toHaveLength(1)
  })

  it('does not render the component path as a visible header inside the tree', () => {
    const state = makeState({
      entries: { b1: { 'pages/index/index': { count: 1 } } },
    })
    const { getByTestId } = render(<AppDataPanel state={state} onSelectBridge={vi.fn()} />)
    expect(getByTestId('appdata-tree').textContent).not.toContain('pages/index/index')
  })
})

describe('AppDataPanel: root default expansion and key order', () => {
  it('shows top-level keys without any interaction, inside the merged appdata-tree container', () => {
    const state = makeState({ entries: { b1: { comp: { count: 1, label: 'hi' } } } })
    const { getByTestId } = render(<AppDataPanel state={state} onSelectBridge={vi.fn()} />)
    const tree = getByTestId('appdata-tree')
    expect(tree.textContent).toContain('count')
    expect(tree.textContent).toContain('label')
  })

  it('shows the root row entry count as {n} for n top-level keys', () => {
    const state = makeState({ entries: { b1: { comp: { alpha: 1, beta: 2, gamma: 3 } } } })
    const { getByTestId } = render(<AppDataPanel state={state} onSelectBridge={vi.fn()} />)
    expect(getByTestId('appdata-tree').textContent).toContain('{3}')
  })

  it('orders top-level keys by Array.prototype.sort() default (code-unit ascending), not insertion order', () => {
    const state = makeState({ entries: { b1: { comp: { zeta: 1, alpha: 2 } } } })
    const { getByTestId } = render(<AppDataPanel state={state} onSelectBridge={vi.fn()} />)
    const text = getByTestId('appdata-tree').textContent ?? ''
    expect(text.indexOf('alpha')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('zeta')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('zeta'))
  })
})

describe('AppDataPanel: non-root node collapse', () => {
  function nestedState(): AppDataState {
    return makeState({
      entries: {
        b1: {
          comp: {
            obj: { first: 1, second: 2 },
            list: [10, 20, 30, 40],
          },
        },
      },
    })
  }

  it('collapses a nested object by default, hiding its keys and showing {n} until the row is clicked', () => {
    const { getByTestId, getByText, queryByText } = render(
      <AppDataPanel state={nestedState()} onSelectBridge={vi.fn()} />,
    )
    expect(queryByText('first')).toBeNull()
    expect(getByTestId('appdata-tree').textContent).toContain('{2}')

    fireEvent.click(getByText('obj'))

    expect(getByText('first')).toBeTruthy()
    expect(getByText('second')).toBeTruthy()
  })

  it('collapses a nested array by default, showing [n] and revealing elements once clicked', () => {
    const { getByTestId, getByText, queryByText } = render(
      <AppDataPanel state={nestedState()} onSelectBridge={vi.fn()} />,
    )
    expect(getByTestId('appdata-tree').textContent).toContain('[4]')
    expect(queryByText('10')).toBeNull()

    fireEvent.click(getByText('list'))

    expect(getByText('10')).toBeTruthy()
  })
})

describe('AppDataPanel: toolbar expand/collapse all', () => {
  function deepState(): AppDataState {
    return makeState({
      entries: {
        b1: {
          comp: {
            outer: { inner: { leaf: 'value' } },
          },
        },
      },
    })
  }

  it('renders a toolbar with 全部展开/全部收起/撤销/重做 controls', () => {
    const { getByTestId, getByTitle } = render(<AppDataPanel state={deepState()} onSelectBridge={vi.fn()} />)
    expect(getByTestId('appdata-toolbar')).toBeTruthy()
    expect(getByTitle('全部展开')).toBeTruthy()
    expect(getByTitle('全部收起')).toBeTruthy()
    expect(getByTitle('撤销')).toBeTruthy()
    expect(getByTitle('重做')).toBeTruthy()
  })

  it('reveals every nested key when 全部展开 is clicked', () => {
    const { getByTitle, getByText, queryByText } = render(
      <AppDataPanel state={deepState()} onSelectBridge={vi.fn()} />,
    )
    expect(queryByText('leaf')).toBeNull()
    fireEvent.click(getByTitle('全部展开'))
    expect(getByText('leaf')).toBeTruthy()
  })

  it('hides every top-level key when 全部收起 is clicked, leaving only the root row', () => {
    const { getByTitle, queryByText } = render(
      <AppDataPanel state={deepState()} onSelectBridge={vi.fn()} />,
    )
    fireEvent.click(getByTitle('全部收起'))
    expect(queryByText('outer')).toBeNull()
  })
})

describe('AppDataPanel: keepalive preserves expand state across bridge switches', () => {
  it('keeps a manually expanded node expanded after switching away and back', () => {
    const state = makeState({
      bridges: [
        { id: 'b1', pagePath: '/pages/index/index' },
        { id: 'b2', pagePath: '/pages/detail/detail' },
      ],
      activeBridgeId: 'b1',
      entries: {
        b1: { comp: { obj: { first: 1 } } },
        b2: { comp: { count: 2 } },
      },
    })
    const { container, getByText, rerender } = render(
      <AppDataPanel state={state} onSelectBridge={vi.fn()} />,
    )
    const b1Tree = (container.querySelector('[data-bridge-id="b1"]') as HTMLElement)
      .querySelector('[data-testid="appdata-tree"]') as HTMLElement
    fireEvent.click(getByText('obj'))
    expect(b1Tree.textContent).toContain('first')

    rerender(<AppDataPanel state={{ ...state, activeBridgeId: 'b2' }} onSelectBridge={vi.fn()} />)
    rerender(<AppDataPanel state={{ ...state, activeBridgeId: 'b1' }} onSelectBridge={vi.fn()} />)

    expect(b1Tree.textContent).toContain('first')
  })
})
