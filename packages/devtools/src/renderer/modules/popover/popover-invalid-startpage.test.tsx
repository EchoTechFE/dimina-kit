/**
 * Contract: the popover's 启动页面 `<Select>` must never silently disagree
 * with `config.startPage`.
 *
 * A `<select>` element falls back to its FIRST `<option>` whenever its
 * `value` prop doesn't match any rendered option — so if `config.startPage`
 * names a page that isn't (or no longer is) in `pages` (e.g. the page was
 * deleted, or the popover opened before a fresh pages list arrived), the
 * dropdown visually shows the wrong page selected while React's `config`
 * state still holds the real (invalid) value. Clicking "重新编译" would
 * then silently relaunch at whatever page happens to be first in the list,
 * not the one the user thinks is selected.
 *
 * Fix under test: `popover.tsx` must render an EXTRA `<option>` for
 * `config.startPage` whenever it is non-empty and absent from `pages`, with
 * a label containing "页面不存在" so the dropdown's visible selection stays
 * truthful. Pages that legitimately exist in `pages` must NOT get this
 * extra option (regression guard against always rendering it).
 */
import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { popoverInitListeners, emitPopoverRelaunch, hidePopover } = vi.hoisted(() => ({
  popoverInitListeners: [] as Array<(payload: unknown) => void>,
  emitPopoverRelaunch: vi.fn(),
  hidePopover: vi.fn(async () => {}),
}))

function emitPopoverInit(payload: {
  top: number
  left: number
  pages: string[]
  config: { startPage: string; scene: number; queryParams: { key: string; value: string }[] }
  launchConfigs?: Array<{ id: string; name: string; startPage: string; scene: number; queryParams: { key: string; value: string }[] }>
  activeLaunchConfigId?: string | null
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
  emitPopoverRelaunch,
  hidePopover,
}))

import Popover from './popover'

beforeEach(() => {
  popoverInitListeners.length = 0
  emitPopoverRelaunch.mockClear()
  hidePopover.mockClear()
})

describe('Popover — invalid startPage must render an explicit option, not silently fall back', () => {
  it('renders an extra option labeled with "页面不存在" when config.startPage is not in pages', () => {
    render(<Popover />)
    act(() => {
      emitPopoverInit({
        top: 0,
        left: 0,
        pages: ['pages/index/index', 'pages/other/other'],
        config: { startPage: 'pages/deleted/deleted', scene: 1011, queryParams: [] },
      })
    })

    const select = screen.getByRole('combobox') as HTMLSelectElement
    // The select's rendered value must actually be the invalid startPage —
    // this is only possible if an <option value="pages/deleted/deleted">
    // exists; otherwise the browser silently falls back to the first option
    // (pages/index/index), and this assertion would already fail on that
    // fallback alone.
    expect(select.value).toBe('pages/deleted/deleted')

    const options = Array.from(select.querySelectorAll('option'))
    const invalidOption = options.find((o) => o.value === 'pages/deleted/deleted')
    expect(
      invalidOption,
      'an <option> for the invalid startPage value must exist so the select can actually show it selected',
    ).toBeTruthy()
    expect(invalidOption!.textContent).toContain('页面不存在')
  })

  it('does NOT render an extra option when config.startPage is a real page in pages', () => {
    render(<Popover />)
    act(() => {
      emitPopoverInit({
        top: 0,
        left: 0,
        pages: ['pages/index/index', 'pages/other/other'],
        config: { startPage: 'pages/other/other', scene: 1011, queryParams: [] },
      })
    })

    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('pages/other/other')
    const options = Array.from(select.querySelectorAll('option'))
    expect(options).toHaveLength(2)
    expect(options.some((o) => o.textContent?.includes('页面不存在'))).toBe(false)
  })

  it('does NOT render an extra option when config.startPage is empty', () => {
    render(<Popover />)
    act(() => {
      emitPopoverInit({
        top: 0,
        left: 0,
        pages: ['pages/index/index'],
        config: { startPage: '', scene: 1011, queryParams: [] },
      })
    })

    const select = screen.getByRole('combobox') as HTMLSelectElement
    const options = Array.from(select.querySelectorAll('option'))
    expect(options.some((o) => o.textContent?.includes('页面不存在'))).toBe(false)
  })

  it('starts in the normal compile editor and relaunches with the init config when no saved launch configs exist', () => {
    render(<Popover />)
    act(() => {
      emitPopoverInit({
        top: 0,
        left: 0,
        pages: ['pages/index/index', 'pages/other/other'],
        config: {
          startPage: 'pages/other/other',
          scene: 2024,
          queryParams: [{ key: 'foo', value: 'bar' }],
        },
      })
    })

    expect(screen.getByRole('combobox')).toHaveValue('pages/other/other')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(emitPopoverRelaunch).toHaveBeenCalledWith({
      startPage: 'pages/other/other',
      scene: 2024,
      queryParams: [{ key: 'foo', value: 'bar' }],
    })
    expect(hidePopover).toHaveBeenCalled()
  })

  it('opens the normal compile editor from the list when normal mode is already active alongside saved launch configs', () => {
    render(<Popover />)
    act(() => {
      emitPopoverInit({
        top: 0,
        left: 0,
        pages: ['pages/index/index', 'pages/other/other'],
        launchConfigs: [
          {
            id: 'lc-1',
            name: '自定义编译',
            startPage: 'pages/index/index',
            scene: 1011,
            queryParams: [],
          },
        ],
        activeLaunchConfigId: null,
        config: { startPage: 'pages/other/other', scene: 1011, queryParams: [] },
      })
    })

    fireEvent.click(screen.getByRole('button', { name: /普通编译/ }))
    expect(screen.getByRole('combobox')).toHaveValue('pages/other/other')
  })
})
