/**
 * AppDataPanel hardening — three edit-path safety contracts on top of the
 * base tree-edit behavior covered by appdata-tree-edit.test.tsx:
 *
 * 1. A nested key whose own text contains `.` or `[`/`]` makes its setData
 *    path ambiguous (the runtime's own-key short-circuit only helps at the
 *    top level; nested writes go through path parsing that would split on
 *    those characters and land on the wrong field). Such rows carry no
 *    `data-path` and are not editable; sibling rows with safe keys are
 *    unaffected.
 * 2. The panel's undo/redo stack advances only once `onSetData` reports
 *    success (`undefined` counts as success for backward compatibility;
 *    `false` — sync or resolved — means the write-back was rejected and the
 *    record must not move). A record whose bridge no longer exists in
 *    `state.bridges` is stale and gets dropped without calling `onSetData`.
 * 3. A number edit that parses to a non-finite value (`Infinity`, or a
 *    literal that overflows to it) is rejected: the edit exits without
 *    calling `onSetData`.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor, within } from '@testing-library/react'
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
        },
      },
    },
  }
}

function unsafeKeyState(): AppDataState {
  return {
    bridges: [{ id: 'b1', pagePath: '/pages/index/index' }],
    activeBridgeId: 'b1',
    entries: {
      b1: {
        comp: {
          profile: { 'first.name': 'A', safe: 'ok' },
          'top.level': 'T',
          arr: [{ 'x[0]': 1, y: 2 }],
        },
      },
    },
  }
}

function unsafeBooleanState(): AppDataState {
  return {
    bridges: [{ id: 'b1', pagePath: '/pages/index/index' }],
    activeBridgeId: 'b1',
    entries: {
      b1: {
        comp: {
          profile: { 'first.enabled': true, safe: false },
        },
      },
    },
  }
}

function nestedEmptyKeyState(): AppDataState {
  return {
    bridges: [{ id: 'b1', pagePath: '/pages/index/index' }],
    activeBridgeId: 'b1',
    entries: {
      b1: {
        comp: {
          profile: { '': 'A', safe: 'B' },
        },
      },
    },
  }
}

function checkboxFor(container: HTMLElement, path: string): HTMLInputElement {
  const row = container.querySelector(`[data-path="${path}"]`) as HTMLElement
  return row.querySelector('input[type="checkbox"]') as HTMLInputElement
}

function valueElFor(container: HTMLElement, path: string): HTMLElement {
  const row = container.querySelector(`[data-path="${path}"]`) as HTMLElement
  return within(row).getByTestId('appdata-value')
}

/** Finds a tree row by its key label text — needed for keys with no
 * `data-path` to query by, since that attribute's presence is exactly what
 * some of these tests are asserting. */
function rowByKey(container: HTMLElement, key: string): HTMLElement {
  const candidates = within(container).getAllByText(key)
  const label = candidates.find((el) => el.tagName === 'SPAN' && el.className.includes('text-code-blue'))
  if (!label) throw new Error(`no row found for key "${key}"`)
  return label.closest('div') as HTMLElement
}

/** Finds a tree row whose key label is the empty string — `getByText('')`
 * can't target it, since an empty string matches too much. */
function rowByEmptyKey(container: HTMLElement): HTMLElement {
  const spans = container.querySelectorAll('span.text-code-blue')
  const label = Array.from(spans).find((el) => el.textContent === '')
  if (!label) throw new Error('no row found for the empty key')
  return label.closest('div') as HTMLElement
}

/** Resolves/rejects on demand — lets a test hold `onSetData` open mid-dispatch
 * to exercise pending/reentrancy behavior before settling it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('AppDataPanel: unsafe nested-key paths are read-only', () => {
  it('gives the `first.name` row no data-path and blocks its double-click editor', () => {
    const { container, getByText } = render(
      <AppDataPanel state={unsafeKeyState()} onSelectBridge={vi.fn()} onSetData={vi.fn()} />,
    )
    fireEvent.click(getByText('profile'))
    const row = rowByKey(container, 'first.name')

    expect(row.hasAttribute('data-path')).toBe(false)
    fireEvent.dblClick(within(row).getByTestId('appdata-value'))
    expect(within(container).queryByRole('textbox')).toBeNull()
  })

  it('keeps the sibling `profile.safe` row editable — only the unsafe key is blocked, not the whole subtree', () => {
    const onSetData = vi.fn()
    const { container, getByText } = render(
      <AppDataPanel state={unsafeKeyState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.click(getByText('profile'))
    const row = rowByKey(container, 'safe')
    expect(row.getAttribute('data-path')).toBe('profile.safe')

    fireEvent.dblClick(within(row).getByTestId('appdata-value'))
    const input = within(container).getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'updated' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSetData).toHaveBeenCalledWith('b1', { 'profile.safe': 'updated' })
  })

  it('keeps a top-level key containing a dot editable — a single path segment resolves by own-key short-circuit', () => {
    const onSetData = vi.fn()
    const { container } = render(
      <AppDataPanel state={unsafeKeyState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    const row = rowByKey(container, 'top.level')
    expect(row.getAttribute('data-path')).toBe('top.level')

    fireEvent.dblClick(within(row).getByTestId('appdata-value'))
    const input = within(container).getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'T2' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSetData).toHaveBeenCalledWith('b1', { 'top.level': 'T2' })
  })

  it('gives the `arr[0].x[0]` row no data-path and blocks its editor — the element key itself contains brackets', () => {
    const { container, getByText } = render(
      <AppDataPanel state={unsafeKeyState()} onSelectBridge={vi.fn()} onSetData={vi.fn()} />,
    )
    fireEvent.click(getByText('arr'))
    const row = rowByKey(container, 'x[0]')

    expect(row.hasAttribute('data-path')).toBe(false)
    fireEvent.dblClick(within(row).getByTestId('appdata-value'))
    expect(within(container).queryByRole('textbox')).toBeNull()
  })

  it('keeps the sibling `arr[0].y` row editable', () => {
    const onSetData = vi.fn()
    const { container, getByText } = render(
      <AppDataPanel state={unsafeKeyState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.click(getByText('arr'))
    const row = rowByKey(container, 'y')
    expect(row.getAttribute('data-path')).toBe('arr[0].y')

    fireEvent.dblClick(within(row).getByTestId('appdata-value'))
    const input = within(container).getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '9' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSetData).toHaveBeenCalledWith('b1', { 'arr[0].y': 9 })
  })

  it('renders no checkbox for a boolean value whose key is unsafe', () => {
    const { container, getByText } = render(
      <AppDataPanel state={unsafeBooleanState()} onSelectBridge={vi.fn()} onSetData={vi.fn()} />,
    )
    fireEvent.click(getByText('profile'))
    const row = rowByKey(container, 'first.enabled')

    expect(row.querySelector('input[type="checkbox"]')).toBeNull()
  })
})

describe('AppDataPanel: undo/redo stack advances only after onSetData succeeds', () => {
  it('leaves 撤销 disabled when onSetData returns false synchronously', () => {
    const onSetData = vi.fn(() => false)
    const { container, getByTitle } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.click(checkboxFor(container, 'flag'))

    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(true)
  })

  it('leaves 撤销 disabled when onSetData resolves to false', async () => {
    const onSetData = vi.fn(() => Promise.resolve(false))
    const { container, getByTitle } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.click(checkboxFor(container, 'flag'))

    await waitFor(() => expect(onSetData).toHaveBeenCalled())
    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not move the undo record when the 撤销 write-back itself is rejected', () => {
    const onSetData = vi.fn(() => true)
    const { container, getByTitle } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.click(checkboxFor(container, 'flag'))
    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(false)

    onSetData.mockImplementation(() => false)
    fireEvent.click(getByTitle('撤销'))

    expect(onSetData).toHaveBeenCalledWith('b1', { flag: true })
    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(false)
    expect((getByTitle('重做') as HTMLButtonElement).disabled).toBe(true)
  })

  it('drops a stale undo record and skips onSetData once its bridge no longer exists', () => {
    const onSetData = vi.fn(() => true)
    const { container, getByTitle, rerender } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.click(checkboxFor(container, 'flag'))
    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(false)

    const otherBridgeState: AppDataState = {
      bridges: [{ id: 'b2', pagePath: '/pages/two/two' }],
      activeBridgeId: 'b2',
      entries: { b2: { comp: { count: 1 } } },
    }
    rerender(<AppDataPanel state={otherBridgeState} onSelectBridge={vi.fn()} onSetData={onSetData} />)
    onSetData.mockClear()

    fireEvent.click(getByTitle('撤销'))

    expect(onSetData).not.toHaveBeenCalled()
    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(true)
    expect((getByTitle('重做') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('AppDataPanel: number edit rejects non-finite input', () => {
  it('does not commit and exits edit mode when the input parses to Infinity', () => {
    const onSetData = vi.fn()
    const { container } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.dblClick(valueElFor(container, 'count'))
    const input = within(container).getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Infinity' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSetData).not.toHaveBeenCalled()
    expect(within(container).queryByRole('textbox')).toBeNull()
  })

  it('does not commit when the input overflows to Infinity (1e309)', () => {
    const onSetData = vi.fn()
    const { container } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.dblClick(valueElFor(container, 'count'))
    const input = within(container).getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '1e309' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSetData).not.toHaveBeenCalled()
    expect(within(container).queryByRole('textbox')).toBeNull()
  })
})

describe('AppDataPanel: a nested empty-string key is read-only', () => {
  it('gives the empty-key row no data-path and blocks its double-click editor — the runtime toPath for `profile.` resolves to just [\'profile\'], so a write would clobber the whole object', () => {
    const { container, getByText } = render(
      <AppDataPanel state={nestedEmptyKeyState()} onSelectBridge={vi.fn()} onSetData={vi.fn()} />,
    )
    fireEvent.click(getByText('profile'))
    const row = rowByEmptyKey(container)

    expect(row.hasAttribute('data-path')).toBe(false)
    fireEvent.dblClick(within(row).getByTestId('appdata-value'))
    expect(within(container).queryByRole('textbox')).toBeNull()
  })

  it('keeps the sibling `profile.safe` row editable — only the empty key is blocked', () => {
    const onSetData = vi.fn()
    const { container, getByText } = render(
      <AppDataPanel state={nestedEmptyKeyState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.click(getByText('profile'))
    const row = rowByKey(container, 'safe')
    expect(row.getAttribute('data-path')).toBe('profile.safe')

    fireEvent.dblClick(within(row).getByTestId('appdata-value'))
    const input = within(container).getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'updated' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSetData).toHaveBeenCalledWith('b1', { 'profile.safe': 'updated' })
  })
})

describe('AppDataPanel: 撤销 guards against a second click racing an in-flight dispatch', () => {
  it('calls onSetData once, disables 撤销 while pending, and settles into a single redo record', async () => {
    const onSetData = vi.fn<(bridgeId: string, patch: Record<string, unknown>) => boolean | Promise<boolean>>(() => true)
    const { container, getByTitle } = render(
      <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.click(checkboxFor(container, 'flag'))
    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(false)

    const write = deferred<boolean>()
    onSetData.mockImplementation(() => write.promise)
    onSetData.mockClear()

    fireEvent.click(getByTitle('撤销'))
    // The write is in flight — the undo stack is still nonempty, so the
    // button must be disabled by pending state, not by an empty stack.
    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(getByTitle('撤销'))
    write.resolve(true)

    await waitFor(() => expect((getByTitle('重做') as HTMLButtonElement).disabled).toBe(false))
    expect(onSetData).toHaveBeenCalledTimes(1)
    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(getByTitle('重做'))
    await waitFor(() => expect((getByTitle('重做') as HTMLButtonElement).disabled).toBe(true))
  })
})

describe('AppDataPanel: a rejected dispatch is treated as failure, not an unhandled rejection', () => {
  it('leaves 撤销 disabled and raises no unhandled promise rejection when onSetData rejects', async () => {
    const unhandled: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      const onSetData = vi.fn(() => Promise.reject(new Error('ipc torn down')))
      const { container, getByTitle } = render(
        <AppDataPanel state={editableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
      )
      fireEvent.click(checkboxFor(container, 'flag'))

      await waitFor(() => expect(onSetData).toHaveBeenCalled())
      expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(true)

      // Gives Node's unhandled-rejection detection a turn to fire before the
      // assertion, so an uncaught rejection inside `dispatch` surfaces here
      // rather than bleeding into a later, unrelated test.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })
})
