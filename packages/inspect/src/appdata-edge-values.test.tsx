/**
 * AppDataPanel edge-value contracts:
 *
 * 1. A write result that is a thenable but not a native `Promise` instance
 *    (a cross-realm promise, a polyfill, any spec-conforming thenable) still
 *    settles asynchronously through its own `then` — it is never treated as
 *    an immediate synchronous success just because it is a truthy, non-`false`
 *    object. The write gate stays held until the thenable actually resolves.
 * 2. An own `__proto__` data key in a setData payload (as produced by
 *    `JSON.parse`, which creates it as a normal own data property, not a
 *    prototype rewire) renders as an ordinary tree row and never reaches the
 *    merged object through a path that would trigger the legacy `__proto__`
 *    accessor and rewire the merged object's prototype.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor, within } from '@testing-library/react'
import { AppDataPanel, type AppDataPanelState as AppDataState } from './appdata-panel-view.js'

function writableState(): AppDataState {
  return {
    bridges: [{ id: 'b1', pagePath: '/pages/index/index' }],
    activeBridgeId: 'b1',
    entries: {
      b1: {
        comp: {
          flag: true,
          label: 'hello',
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

/** Double-click a string/number row, replace its text, and commit on Enter. */
function commitText(container: HTMLElement, path: string, value: string): void {
  fireEvent.dblClick(valueElFor(container, path))
  const input = within(container).getByRole('textbox') as HTMLInputElement
  fireEvent.change(input, { target: { value } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

/** A thenable that is deliberately not a `Promise` instance — same shape a
 * cross-realm promise or a promise polyfill returns. `settled` flips only
 * once the thenable's own `then` callback actually runs (a real macrotask
 * later), so tests can wait for genuine settlement instead of guessing at a
 * delay. */
function fakeThenable(resolveWith: boolean): { thenable: { then: (res: (v: boolean) => void) => void }; state: { settled: boolean } } {
  const state = { settled: false }
  const thenable = {
    then(res: (v: boolean) => void) {
      setTimeout(() => {
        state.settled = true
        res(resolveWith)
      }, 0)
    },
  }
  return { thenable, state }
}

describe('AppDataPanel: a thenable write result settles asynchronously, never as a same-tick success', () => {
  it('keeps the commit off the undo stack until the thenable actually resolves, and rejects it once it does', async () => {
    const { thenable, state } = fakeThenable(false)
    expect(thenable).not.toBeInstanceOf(Promise)
    const onSetData = vi.fn(() => thenable as unknown as Promise<boolean>)
    const { container, getByTitle } = render(
      <AppDataPanel state={writableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )

    fireEvent.click(checkboxFor(container, 'flag'))
    expect(onSetData).toHaveBeenCalledTimes(1)
    // A truthy, non-`false` thenable is not a synchronous success — the gate
    // must still be held in the same tick as the click that fired it.
    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(true)

    await waitFor(() => expect(state.settled).toBe(true))
    // The thenable resolved to `false` (a rejection) — the record never
    // lands on the undo stack, even after real settlement.
    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(true)
  })

  it('drops a second edit fired while the first thenable write is still pending', async () => {
    const { thenable, state } = fakeThenable(true)
    const onSetData = vi.fn(() => thenable as unknown as Promise<boolean>)
    const { container, getByTitle } = render(
      <AppDataPanel state={writableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )

    fireEvent.click(checkboxFor(container, 'flag'))
    expect(onSetData).toHaveBeenCalledTimes(1)
    expect(state.settled).toBe(false)

    // The write gate must still be held here — the first thenable has not
    // resolved yet, so this edit has to be dropped outright, never queued.
    commitText(container, 'label', 'ignored')
    expect(onSetData).toHaveBeenCalledTimes(1)

    await waitFor(() => expect(state.settled).toBe(true))
    await waitFor(() => expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(false))
    // Settlement only ever admitted the first write — the dropped edit never
    // reached onSetData, not even after the gate freed up.
    expect(onSetData).toHaveBeenCalledTimes(1)
  })
})

describe('AppDataPanel: an own `__proto__` data key renders as a plain, read-only row', () => {
  it('does not let the nested key leak onto the merged tree, keeps the sibling key intact, and keeps `__proto__` itself visible and read-only', () => {
    const data = JSON.parse('{"__proto__":{"hidden":1},"safe":2}') as Record<string, unknown>
    // JSON.parse creates `__proto__` as a normal own data property (per spec,
    // via CreateDataProperty) — this is not a prototype rewire of `data`
    // itself, only a risk if something later assigns `data` into another
    // object through the legacy `[[Set]]` path (e.g. `Object.assign`).
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype)
    expect(Object.keys(data).sort()).toEqual(['__proto__', 'safe'])

    const state: AppDataState = {
      bridges: [{ id: 'b1', pagePath: '/pages/index/index' }],
      activeBridgeId: 'b1',
      entries: { b1: { comp: data } },
    }
    const { container, queryByText } = render(
      <AppDataPanel state={state} onSelectBridge={vi.fn()} onSetData={vi.fn(() => true)} />,
    )

    // The nested key never surfaces as a row of its own — a merge that runs
    // `__proto__` through the legacy setter would rewire the merged object's
    // prototype and make `hidden` an inherited (not own) property that no
    // row is ever built for.
    expect(queryByText('hidden')).toBeNull()
    // The sibling key merges normally regardless of what happens to
    // `__proto__` alongside it.
    expect(valueElFor(container, 'safe').textContent).toBe('2')

    // `__proto__` itself is real, visible data — a prototype-rewiring merge
    // makes it vanish as an own key entirely, so this is the row that would
    // never render on the unfixed merge.
    expect(queryByText('__proto__')).not.toBeNull()
    // And it stays read-only: no row for it may ever carry a write path.
    expect(container.querySelector('[data-path="__proto__"]')).toBeNull()
  })
})
