/**
 * AppDataPanel — a single write gate admits at most one in-flight write
 * across every write path (commit and replay share it): while a write is
 * pending, any further commit or replay request is dropped outright — no
 * local echo, no queued follow-up, no second `onSetData` call. This is what
 * keeps undo/redo stack order honest when a click races an in-flight async
 * write:
 *
 * 1. A commit fired while a replay (撤销/重做) is in flight is dropped, so a
 *    resolving replay can never re-add a record that a same-turn commit
 *    already invalidated by clearing the redo stack.
 * 2. A second commit fired while the first is still in flight is dropped, so
 *    the undo stack only ever grows by the write that was actually
 *    dispatched — never out of commit order.
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
          seed: 'S0',
          a: 'A0',
          b: 'B0',
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

/** Resolves/rejects on demand — lets a test hold `onSetData` open mid-dispatch
 * to exercise pending/reentrancy behavior before settling it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('AppDataPanel: a commit is dropped while a replay is in flight', () => {
  it('never calls onSetData for the dropped commit, and settles into a single redo record — never a resurrected one', async () => {
    const onSetData = vi.fn<(bridgeId: string, patch: Record<string, unknown>) => boolean | Promise<boolean>>(() => true)
    const { container, getByTitle } = render(
      <AppDataPanel state={writableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    fireEvent.click(checkboxFor(container, 'flag'))
    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(false)

    const write = deferred<boolean>()
    onSetData.mockImplementation(() => write.promise)
    onSetData.mockClear()

    fireEvent.click(getByTitle('撤销'))
    expect(onSetData).toHaveBeenCalledTimes(1)

    // A commit on an unrelated field lands mid-replay — the write gate must
    // drop it before it ever reaches onSetData.
    commitText(container, 'label', 'ignored')
    expect(onSetData).toHaveBeenCalledTimes(1)

    write.resolve(true)
    await waitFor(() => expect((getByTitle('重做') as HTMLButtonElement).disabled).toBe(false))
    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(true)
    // Stack state matches "the dropped commit never happened": exactly the
    // one replayed record moved to redo, nothing extra came back onto it.
    expect(onSetData).toHaveBeenCalledTimes(1)

    fireEvent.click(getByTitle('重做'))
    await waitFor(() => expect((getByTitle('重做') as HTMLButtonElement).disabled).toBe(true))
    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('AppDataPanel: a second commit is dropped while the first is in flight', () => {
  it('calls onSetData once for the in-flight commit, disables 撤销/重做 while it is pending even with a nonempty stack, and undoes only the write that was actually dispatched', async () => {
    const onSetData = vi.fn<(bridgeId: string, patch: Record<string, unknown>) => boolean | Promise<boolean>>(() => true)
    const { container, getByTitle } = render(
      <AppDataPanel state={writableState()} onSelectBridge={vi.fn()} onSetData={onSetData} />,
    )
    // Seed a synchronously-settled undo record so the stack is nonempty
    // before the race below — otherwise "disabled" would be indistinguishable
    // from an empty-stack disable, not the write gate's pending state.
    commitText(container, 'seed', 'S1')
    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(false)

    const pending: Array<(value: boolean) => void> = []
    onSetData.mockImplementation(() => new Promise<boolean>((resolve) => { pending.push(resolve) }))
    onSetData.mockClear()

    commitText(container, 'a', 'A1')
    expect(onSetData).toHaveBeenCalledTimes(1)
    // The write gate's pending state disables both buttons even though the
    // undo stack is nonempty — an in-flight commit holds the gate exactly
    // like an in-flight replay does.
    expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(true)
    expect((getByTitle('重做') as HTMLButtonElement).disabled).toBe(true)

    commitText(container, 'b', 'B1')
    expect(onSetData).toHaveBeenCalledTimes(1)

    pending[0]?.(true)
    await waitFor(() => expect((getByTitle('撤销') as HTMLButtonElement).disabled).toBe(false))
    expect(onSetData).toHaveBeenCalledTimes(1)

    fireEvent.click(getByTitle('撤销'))
    // Only `a` was ever committed — `b` never reached onSetData — so the
    // record undo replays is necessarily `a`'s.
    expect(onSetData).toHaveBeenLastCalledWith('b1', { a: 'A0' })
  })
})
