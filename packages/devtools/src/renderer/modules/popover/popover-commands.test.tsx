/**
 * The popover no longer computes a whole new compile-mode list and sends it
 * back — every user action dispatches a single command, and identity flows
 * through ids instead of list position:
 *  - selecting a row (普通编译 included) → `{type:'select', id}`, id null for
 *    普通编译;
 *  - 新建/以当前页面新建 → confirming the dialog → `{type:'add', mode}`;
 *  - editing an existing entry → confirming → `{type:'update', id, mode}`,
 *    carrying the id the row was opened with, not its position;
 *  - deleting from the editor → `{type:'remove', id}`.
 *
 * Two entries that happen to share a display name must stay independently
 * selectable and editable — a regression guard against keying the menu rows
 * by list index (`key={i}`), which is silently correct for adjacent clicks
 * but breaks identity once entries are reordered or one is removed.
 */
import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { routeToMode } from '../../../shared/compile-modes'
import type { CompileMode } from '../../shared/types'

interface FakeCompileModeState {
  selectedId: string | null
  entries: Array<{ id: string; mode: CompileMode }>
}

type FakePopoverCommand =
  | { type: 'select'; id: string | null }
  | { type: 'add'; mode: CompileMode }
  | { type: 'update'; id: string; mode: CompileMode }
  | { type: 'remove'; id: string }

const { popoverInitListeners, applyPopoverCommand } = vi.hoisted(() => ({
  popoverInitListeners: [] as Array<(payload: unknown) => void>,
  applyPopoverCommand: vi.fn(async (_command: FakePopoverCommand) => {}),
}))

function emitPopoverInit(payload: {
  top: number
  left: number
  pages: string[]
  state: FakeCompileModeState
  entryPagePath: string
  currentRoute: string
}): void {
  for (const fn of [...popoverInitListeners]) fn(payload)
}

vi.mock('@/shared/api', () => ({
  onPopoverInit: vi.fn((handler: (payload: unknown) => void) => {
    popoverInitListeners.push(handler)
    return () => {
      const i = popoverInitListeners.indexOf(handler)
      if (i >= 0) popoverInitListeners.splice(i, 1)
    }
  }),
  applyPopoverCommand,
  hidePopover: vi.fn(async () => {}),
  notifyOverlayReady: vi.fn(),
}))

import Popover from './popover'

beforeEach(() => {
  popoverInitListeners.length = 0
  applyPopoverCommand.mockClear()
})

const cartMode: CompileMode = { name: '购物车', pathName: 'pages/cart/cart', query: '', scene: null }

function openWith(state: FakeCompileModeState, extra?: Partial<{ pages: string[]; entryPagePath: string; currentRoute: string }>) {
  render(<Popover />)
  act(() => {
    emitPopoverInit({
      top: 0,
      left: 0,
      pages: extra?.pages ?? ['pages/index/index', 'pages/cart/cart'],
      state,
      entryPagePath: extra?.entryPagePath ?? 'pages/index/index',
      currentRoute: extra?.currentRoute ?? '',
    })
  })
}

describe('popover menu: selecting dispatches by id', () => {
  it('clicking a named entry sends select with its id', () => {
    openWith({ selectedId: null, entries: [{ id: 'm1', mode: cartMode }] })

    fireEvent.click(screen.getByText('购物车'))

    expect(applyPopoverCommand).toHaveBeenCalledWith({ type: 'select', id: 'm1' })
  })

  it('clicking 普通编译 sends select with id null', () => {
    openWith({ selectedId: 'm1', entries: [{ id: 'm1', mode: cartMode }] })

    fireEvent.click(screen.getByText('普通编译'))

    expect(applyPopoverCommand).toHaveBeenCalledWith({ type: 'select', id: null })
  })
})

describe('popover menu: duplicate names stay independently selectable by id', () => {
  it('two entries named alike dispatch their own distinct ids, not shared/positional ones', () => {
    const dup1: CompileMode = { name: '同名模式', pathName: 'pages/a/a', query: '', scene: null }
    const dup2: CompileMode = { name: '同名模式', pathName: 'pages/b/b', query: '', scene: null }
    openWith({
      selectedId: null,
      entries: [
        { id: 'dup1', mode: dup1 },
        { id: 'dup2', mode: dup2 },
      ],
    }, { pages: ['pages/a/a', 'pages/b/b'] })

    const rows = screen.getAllByText('同名模式')
    expect(rows).toHaveLength(2)

    fireEvent.click(rows[0])
    fireEvent.click(rows[1])

    expect(applyPopoverCommand).toHaveBeenNthCalledWith(1, { type: 'select', id: 'dup1' })
    expect(applyPopoverCommand).toHaveBeenNthCalledWith(2, { type: 'select', id: 'dup2' })
  })

  it('marks only the entry whose id matches selectedId as checked, even when names collide', () => {
    const dup1: CompileMode = { name: '同名模式', pathName: 'pages/a/a', query: '', scene: null }
    const dup2: CompileMode = { name: '同名模式', pathName: 'pages/b/b', query: '', scene: null }
    openWith({
      selectedId: 'dup2',
      entries: [
        { id: 'dup1', mode: dup1 },
        { id: 'dup2', mode: dup2 },
      ],
    }, { pages: ['pages/a/a', 'pages/b/b'] })

    const rows = screen.getAllByRole('menuitemradio', { name: '同名模式' })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute('aria-checked', 'false')
    expect(rows[1]).toHaveAttribute('aria-checked', 'true')
  })
})

describe('popover editor: creating from the current page seeds mode from routeToMode', () => {
  it('confirming "以当前页面新建" sends add with a mode derived from the running route', () => {
    openWith({ selectedId: null, entries: [] }, { currentRoute: 'pages/cart/cart?from=share' })

    fireEvent.click(screen.getByText('以当前页面新建'))
    fireEvent.click(screen.getByText('保存'))

    expect(applyPopoverCommand).toHaveBeenCalledTimes(1)
    const [command] = applyPopoverCommand.mock.calls[0]!
    expect(command.type).toBe('add')
    if (command.type !== 'add') throw new Error('expected an add command')
    const expectedPathName = routeToMode('pages/cart/cart?from=share', '').pathName
    expect(command.mode.pathName).toBe(expectedPathName)
  })
})

describe('popover editor: editing an existing entry sends update with its original id', () => {
  it('changing the name and saving sends update, not add, carrying the entry\'s id', () => {
    openWith({ selectedId: null, entries: [{ id: 'm1', mode: cartMode }] })

    fireEvent.click(screen.getByLabelText('编辑 购物车'))
    const nameInput = screen.getByDisplayValue('购物车')
    fireEvent.change(nameInput, { target: { value: '购物车（改名）' } })
    fireEvent.click(screen.getByText('保存'))

    expect(applyPopoverCommand).toHaveBeenCalledWith({
      type: 'update',
      id: 'm1',
      mode: { ...cartMode, name: '购物车（改名）' },
    })
  })
})

describe('popover editor: deleting sends remove with the entry\'s id', () => {
  it('clicking 删除模式 in the editor sends remove for the id it was opened with', () => {
    openWith({ selectedId: null, entries: [{ id: 'm1', mode: cartMode }] })

    fireEvent.click(screen.getByLabelText('编辑 购物车'))
    fireEvent.click(screen.getByText('删除模式'))

    expect(applyPopoverCommand).toHaveBeenCalledWith({ type: 'remove', id: 'm1' })
  })
})

describe('popover: a rejected apply command must not become an unhandled rejection', () => {
  it('clicking 普通编译 while main rejects the apply attaches a handler to that rejection', async () => {
    // Neither Node's `process` 'unhandledRejection' event nor vitest's own
    // "Unhandled Errors" reporter fires for a rejection returned from
    // invoking a `vi.fn()` mock — vitest's own call-result bookkeeping
    // (verified empirically: it calls `.then` on the return value exactly
    // once, purely for its own tracking) is enough to keep Node from ever
    // seeing it as unhandled, independent of whether the CALLING code does
    // anything with it. So this guard measures the thing that actually
    // varies: how many `.then` calls land on the click's own rejection,
    // against a control rejection from the same mock that's never routed
    // through any component and is deliberately left untouched. `.catch`,
    // `.then`, and `await` inside try/catch all resolve to a
    // `Promise.prototype.then` call, so this catches any of them; a bare
    // `void applyPopoverCommand(...)` (the current code) adds nothing
    // beyond vitest's own bookkeeping, so the two counts come out equal.
    const originalThen = Promise.prototype.then
    const thenCounts = new Map<Promise<unknown>, number>()
    Promise.prototype.then = function (this: Promise<unknown>, ...args: unknown[]) {
      if (thenCounts.has(this)) thenCounts.set(this, thenCounts.get(this)! + 1)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalThen.apply(this, args as any)
    } as typeof originalThen

    try {
      const controlRejection = Promise.reject(new Error('control, never clicked'))
      thenCounts.set(controlRejection, 0)
      applyPopoverCommand.mockImplementationOnce(() => controlRejection)
      void applyPopoverCommand({ type: 'remove', id: 'control-probe' })
      await new Promise((resolve) => setTimeout(resolve, 0))

      const clickRejection = Promise.reject(new Error('disk full'))
      thenCounts.set(clickRejection, 0)
      applyPopoverCommand.mockImplementationOnce(() => clickRejection)

      openWith({ selectedId: 'm1', entries: [{ id: 'm1', mode: cartMode }] })
      fireEvent.click(screen.getByRole('menuitemradio', { name: '普通编译' }))

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      expect(applyPopoverCommand).toHaveBeenCalledWith({ type: 'select', id: null })
      expect(thenCounts.get(clickRejection)).toBeGreaterThan(thenCounts.get(controlRejection)!)
    } finally {
      Promise.prototype.then = originalThen
    }
  })
})
