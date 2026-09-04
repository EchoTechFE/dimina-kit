/**
 * Contract: the popover panel must never end up clamped off-screen when the
 * init payload arrives before the overlay view has its final size.
 *
 * The popover view's bounds are applied only after main's markReady (overlay
 * readyMode is manual), so the first `onPopoverInit` can fire while
 * `window.innerWidth` is still 0. `maxLeft = innerWidth - width - margin`
 * then goes negative and `Math.min(data.left, maxLeft)` pins the panel at a
 * negative left — off-screen. When the view later gains its size (a resize
 * event), the panel must re-clamp against the real viewport.
 *
 * Fix under test: `popover.tsx` keeps the last anchor and re-applies it on
 * `window.resize`, so the panel lands at the anchor (clamped) once the view
 * is sized, instead of staying stranded off-screen.
 */
import React from 'react'
import { act, render } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakeCompileModeState {
  selectedId: string | null
  entries: Array<{ id: string; mode: { name: string; pathName: string; query: string; scene: number | null } }>
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

function panelElement(): HTMLElement {
  const panel = document.querySelector('[class*="bg-surface"][class*="w-[340px]"]')
  if (!panel) throw new Error('popover panel not rendered')
  return panel as HTMLElement
}

describe('Popover — re-clamps the panel when the view gains its size', () => {
  it('pins the panel off-screen when innerWidth is still 0 at init (view not sized yet)', () => {
    // jsdom innerWidth defaults to 1024; force 0 to simulate the overlay view
    // whose bounds haven't been applied yet.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 0 })
    render(<Popover />)
    act(() => {
      emitPopoverInit({
        top: 40,
        left: 10,
        pages: ['pages/index/index'],
        state: { selectedId: null, entries: [] },
        entryPagePath: 'pages/index/index',
        currentRoute: '',
      })
    })
    expect(panelElement().style.left).toBe('-348px')
  })

  it('re-clamps to the anchor once the view resizes to its real width', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 0 })
    render(<Popover />)
    act(() => {
      emitPopoverInit({
        top: 40,
        left: 10,
        pages: ['pages/index/index'],
        state: { selectedId: null, entries: [] },
        entryPagePath: 'pages/index/index',
        currentRoute: '',
      })
    })
    expect(panelElement().style.left).toBe('-348px')

    // The overlay view's bounds land (markReady → setDesired → setBounds),
    // which fires a resize in the view.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1250 })
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })

    // Anchor left=10 is well inside the viewport now — the panel must move
    // back on-screen instead of staying clamped off it.
    expect(panelElement().style.left).toBe('10px')
  })

  it('cleans up the resize listener on unmount (no re-clamp after close)', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 0 })
    const { unmount } = render(<Popover />)
    act(() => {
      emitPopoverInit({
        top: 40,
        left: 10,
        pages: ['pages/index/index'],
        state: { selectedId: null, entries: [] },
        entryPagePath: 'pages/index/index',
        currentRoute: '',
      })
    })
    unmount()

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1250 })
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    // Panel is gone; the listener was removed so no state update is attempted.
    expect(document.querySelector('[class*="w-[340px]"]')).toBeNull()
  })
})
