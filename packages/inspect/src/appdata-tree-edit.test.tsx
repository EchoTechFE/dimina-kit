/**
 * AppDataPanel — WeChat setData-style tree editing.
 *
 * Editing is gated entirely on `onSetData` being passed: without it the tree
 * is read-only (no checkboxes, double-click does nothing). With it, every
 * primitive (string/number/boolean) value row carries a `data-path` in the
 * WeChat setData path syntax (`user.name`, `list[0].id`); booleans edit via
 * an inline checkbox, string/number values edit via a double-click-activated
 * textbox committed on Enter (Escape cancels); object/array/null values
 * never become editable. The panel also keeps its own undo/redo stack over
 * committed edits, independent of whatever the host echoes back through
 * `state`.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, within } from '@testing-library/react'
import { AppDataPanel, type AppDataPanelState as AppDataState } from './appdata-panel-view.js'

function editableState(): AppDataState {
  return {
    bridges: [{ id: 'b1', pagePath: '/pages/index/index' }],
    activeBridgeId: 'b1',
    entries: {
      b1: {
        comp: {
          count: 1,
          flag: true,
          label: 'hello',
          user: { name: 'alice', age: 3 },
          list: [{ id: 1 }, { id: 2 }],
          empty: null,
        },
      },
    },
  }
}

function valueElFor(container: HTMLElement, path: string): HTMLElement {
  const row = container.querySelector(`[data-path="${path}"]`) as HTMLElement
  return within(row).getByTestId('appdata-value')
}

function checkboxFor(container: HTMLElement, path: string): HTMLInputElement {
  const row = container.querySelector(`[data-path="${path}"]`) as HTMLElement
  return row.querySelector('input[type="checkbox"]') as HTMLInputElement
}

describe('AppDataPanel: read-only tree without onSetData', () => {
  it('renders no checkboxes when onSetData is not provided', () => {
    const { container } = render(<AppDataPanel state={editableState()} onSelectBridge={vi.fn()} />)
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  })

  it('does not open an editable textbox on double-click when onSetData is not provided', () => {
    const { getByText, queryByRole } = render(<AppDataPanel state={editableState()} onSelectBridge={vi.fn()} />)
    fireEvent.dblClick(getByText('hello'))
    expect(queryByRole('textbox')).toBeNull()
  })
})

describe('AppDataPanel: data-path attributes (edit mode)', () => {
  it('sets data-path to the top-level key for a root primitive', () => {
    const { container } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={vi.fn()} />,
    )
    expect(container.querySelector('[data-path="count"]')).not.toBeNull()
  })

  it('sets data-path to dot notation for a nested object key', () => {
    const { container, getByText } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={vi.fn()} />,
    )
    fireEvent.click(getByText('user'))
    expect(container.querySelector('[data-path="user.name"]')).not.toBeNull()
  })

  it('sets data-path to WeChat setData array-index-then-key notation for an array element field', () => {
    const { container, getByText } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={vi.fn()} />,
    )
    fireEvent.click(getByText('list'))
    expect(container.querySelector('[data-path="list[0].id"]')).not.toBeNull()
    expect(container.querySelector('[data-path="list[1].id"]')).not.toBeNull()
  })

  it('does not set data-path on object/array/null values', () => {
    const { container } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={vi.fn()} />,
    )
    // A sibling primitive at the same level DOES carry data-path — proves the
    // absence above is the object/array/null exclusion, not a global lack of
    // data-path support.
    expect(container.querySelector('[data-path="count"]')).not.toBeNull()
    expect(container.querySelector('[data-path="user"]')).toBeNull()
    expect(container.querySelector('[data-path="list"]')).toBeNull()
    expect(container.querySelector('[data-path="empty"]')).toBeNull()
  })
})

describe('AppDataPanel: boolean checkbox toggle', () => {
  it('renders a checked checkbox reflecting a true boolean value', () => {
    const { container } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={vi.fn()} />,
    )
    expect(checkboxFor(container, 'flag').checked).toBe(true)
  })

  it('calls onSetData with the flipped value when the checkbox is clicked', () => {
    const onSetData = vi.fn()
    const { container } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.click(checkboxFor(container, 'flag'))
    expect(onSetData).toHaveBeenCalledWith('b1', { flag: false })
  })
})

describe('AppDataPanel: string/number inline edit via double-click', () => {
  it('opens a prefilled textbox on double-click of a string value', () => {
    const { container } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={vi.fn()} />,
    )
    fireEvent.dblClick(valueElFor(container, 'label'))
    const input = within(container).getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('hello')
  })

  it('commits a string edit as raw text on Enter and exits edit mode', () => {
    const onSetData = vi.fn()
    const { container } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.dblClick(valueElFor(container, 'label'))
    const input = within(container).getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'world' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSetData).toHaveBeenCalledWith('b1', { label: 'world' })
    expect(within(container).queryByRole('textbox')).toBeNull()
  })

  it('commits a number edit as Number(input) on Enter', () => {
    const onSetData = vi.fn()
    const { container } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.dblClick(valueElFor(container, 'count'))
    const input = within(container).getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '42' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSetData).toHaveBeenCalledWith('b1', { count: 42 })
  })

  it('does not commit and exits edit mode when the number input is not a valid number', () => {
    const onSetData = vi.fn()
    const { container } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.dblClick(valueElFor(container, 'count'))
    const input = within(container).getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'not-a-number' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSetData).not.toHaveBeenCalled()
    expect(within(container).queryByRole('textbox')).toBeNull()
  })

  it('discards the edit and exits edit mode on Escape without calling onSetData', () => {
    const onSetData = vi.fn()
    const { container } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.dblClick(valueElFor(container, 'label'))
    const input = within(container).getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onSetData).not.toHaveBeenCalled()
    expect(within(container).queryByRole('textbox')).toBeNull()
  })
})

describe('AppDataPanel: undo/redo', () => {
  it('starts with 撤销 and 重做 both disabled', () => {
    const { getByTitle } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={vi.fn()} />,
    )
    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(true)
    expect((getByTitle('重做') as HTMLButtonElement).disabled).toBe(true)
  })

  it('enables 撤销 (but not 重做) after one committed edit', () => {
    const onSetData = vi.fn()
    const { container, getByTitle } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.click(checkboxFor(container, 'flag'))

    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(false)
    expect((getByTitle('重做') as HTMLButtonElement).disabled).toBe(true)
  })

  it('calls onSetData with the pre-edit value on 撤销 and enables 重做', () => {
    const onSetData = vi.fn()
    const { container, getByTitle } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.click(checkboxFor(container, 'flag'))
    onSetData.mockClear()

    fireEvent.click(getByTitle('撤销'))

    expect(onSetData).toHaveBeenCalledWith('b1', { flag: true })
    expect((getByTitle('重做') as HTMLButtonElement).disabled).toBe(false)
  })

  it('calls onSetData with the post-edit value on 重做', () => {
    const onSetData = vi.fn()
    const { container, getByTitle } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.click(checkboxFor(container, 'flag'))
    fireEvent.click(getByTitle('撤销'))
    onSetData.mockClear()

    fireEvent.click(getByTitle('重做'))

    expect(onSetData).toHaveBeenCalledWith('b1', { flag: false })
  })

  it('clears the redo stack once a new edit is committed after an undo', () => {
    const onSetData = vi.fn()
    const { container, getByTitle } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.click(checkboxFor(container, 'flag'))
    fireEvent.click(getByTitle('撤销'))
    expect((getByTitle('重做') as HTMLButtonElement).disabled).toBe(false)

    fireEvent.dblClick(valueElFor(container, 'count'))
    const input = within(container).getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect((getByTitle('重做') as HTMLButtonElement).disabled).toBe(true)
  })
})
