/**
 * Contract: the 编译模式编辑弹窗 (`CompileModeDialog`) 的「启动页面」`<select>` must
 * render an option whose `value` matches the form's `pathName` state, for
 * every `pathName` the form can hold — never fall back to whichever option
 * happens to be first.
 *
 * A `<select>` silently shows its first `<option>` selected whenever its
 * `value` prop doesn't match any rendered option. If the dropdown's visible
 * selection disagrees with `pathName`, the user reads the wrong start page
 * off the screen while 保存 would actually launch at the real (invisible)
 * one — a mismatch between what's shown and what fires.
 *
 * Three `pathName` shapes the form must keep honest:
 * - a name that isn't in `pages` (mode edited after its page was deleted, or
 *   opened before a fresh pages list arrived) → needs an extra option for
 *   that exact value, labeled with "页面不存在" so the user can tell it's
 *   invalid instead of reading it as a real page;
 * - a name that IS in `pages` → no extra "页面不存在" option (regression
 *   guard against always rendering one; this does NOT affect the value=""
 *   "默认为首页" option below, which is always present regardless of
 *   `pathName`);
 * - the empty string, which means "launch at whatever the entry page is" →
 *   needs an option with `value=""` labeled "默认为首页", not a select that
 *   silently lands on the first real page instead.
 *
 * The editor only renders once the popover opens it over the menu, so each
 * case drives the popover there first: click a mode's pencil to edit it, or
 * "添加编译模式" to create one.
 *
 * Init payload carries the id-based `state: CompileModeState`, not the old
 * index-based `modes: {current, list}` — the menu's entries are keyed and
 * edited by id.
 */
import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CompileMode } from '../../shared/types'

interface FakeCompileModeState {
  selectedId: string | null
  entries: Array<{ id: string; mode: CompileMode }>
}

const { popoverInitListeners } = vi.hoisted(() => ({
  popoverInitListeners: [] as Array<(payload: unknown) => void>,
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
  applyPopoverCommand: vi.fn(async () => {}),
  hidePopover: vi.fn(async () => {}),
  notifyOverlayReady: vi.fn(),
}))

import Popover from './popover'

beforeEach(() => {
  popoverInitListeners.length = 0
})

describe('CompileModeDialog — 启动页面 select stays truthful for every pathName the editor can hold', () => {
  it('renders an extra option labeled "页面不存在" when the edited mode\'s pathName is not in pages', () => {
    render(<Popover />)
    act(() => {
      emitPopoverInit({
        top: 0,
        left: 0,
        pages: ['pages/index/index', 'pages/other/other'],
        state: {
          selectedId: null,
          entries: [{ id: 'm1', mode: { name: '已删除页面', pathName: 'pages/deleted/deleted', query: '', scene: null } }],
        },
        entryPagePath: 'pages/index/index',
        currentRoute: '',
      })
    })
    fireEvent.click(screen.getByLabelText('编辑 已删除页面'))

    const select = screen.getByRole('combobox') as HTMLSelectElement
    // The select's rendered value must actually be the invalid pathName —
    // this is only possible if an <option value="pages/deleted/deleted">
    // exists; otherwise the browser silently falls back to the first option
    // (pages/index/index), and this assertion would already fail on that
    // fallback alone.
    expect(select.value).toBe('pages/deleted/deleted')

    const options = Array.from(select.querySelectorAll('option'))
    const invalidOption = options.find((o) => o.value === 'pages/deleted/deleted')
    expect(
      invalidOption,
      'an <option> for the invalid pathName must exist so the select can actually show it selected',
    ).toBeTruthy()
    expect(invalidOption!.textContent).toContain('页面不存在')
  })

  it('does NOT render an extra option when the edited mode\'s pathName is a real page in pages', () => {
    render(<Popover />)
    act(() => {
      emitPopoverInit({
        top: 0,
        left: 0,
        pages: ['pages/index/index', 'pages/other/other'],
        state: {
          selectedId: null,
          entries: [{ id: 'm1', mode: { name: '其他页面', pathName: 'pages/other/other', query: '', scene: null } }],
        },
        entryPagePath: 'pages/index/index',
        currentRoute: '',
      })
    })
    fireEvent.click(screen.getByLabelText('编辑 其他页面'))

    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('pages/other/other')
    const options = Array.from(select.querySelectorAll('option'))
    // The value="" 默认为首页 option is a permanent fixture, not conditional
    // on pathName — only the "页面不存在" option is what this case guards
    // against over-rendering.
    expect(options.map((o) => o.value)).toEqual(['', 'pages/index/index', 'pages/other/other'])
    expect(options.some((o) => o.textContent?.includes('页面不存在'))).toBe(false)
  })

  it('renders a value="" option labeled "默认为首页" when a newly created mode\'s pathName is empty', () => {
    render(<Popover />)
    act(() => {
      emitPopoverInit({
        top: 0,
        left: 0,
        pages: ['pages/index/index'],
        state: { selectedId: null, entries: [] },
        // Empty entryPagePath is the case that seeds a new mode's pathName
        // with '' — nothing was reported as the app's entry page yet.
        entryPagePath: '',
        currentRoute: '',
      })
    })
    fireEvent.click(screen.getByText('添加编译模式'))

    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('')

    const options = Array.from(select.querySelectorAll('option'))
    const defaultOption = options.find((o) => o.value === '')
    expect(
      defaultOption,
      'an <option value=""> must exist so the select can show "默认为首页" instead of silently falling back to the first real page',
    ).toBeTruthy()
    expect(defaultOption!.textContent).toContain('默认为首页')
    expect(options.some((o) => o.textContent?.includes('页面不存在'))).toBe(false)
  })
})
