/**
 * Characterization tests for `<UiOverlay>`: the React component that renders
 * toasts, modals and action sheets inside the device frame, driven by
 * `uiOverlayBus`.
 *
 * Key contracts:
 * - Toast auto-dismiss: a finite-duration toast disappears after its timer
 *   fires; showLoading (Infinity) does not auto-dismiss.
 * - Stale-timer safety: if showToast(t1) fires a 1500ms timer, then at 1000ms
 *   showToast(t2) replaces t1, advancing another 600ms (past t1's deadline)
 *   must NOT clear t2 — the component delegates to `dismissToast(toast)` which
 *   only clears when the stored toast reference is still active.
 * - Modal: pushing a modal via the bus renders it; clicking the confirm button
 *   calls onResult(true).
 * - Modal mask: a `.dmui-mask` element is present while a modal is open.
 */
import React from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UiOverlay } from './ui-overlay'
import { uiOverlayBus } from '../ui-overlay-bus'
import type { ToastState } from '../ui-overlay-bus'

beforeEach(() => {
  vi.useFakeTimers()
  uiOverlayBus.hideToast()
  uiOverlayBus.hideDialog()
})

afterEach(() => {
  uiOverlayBus.hideToast()
  uiOverlayBus.hideDialog()
  vi.useRealTimers()
})

// ─── Toast auto-dismiss ───────────────────────────────────────────────────────

describe('UiOverlay — toast auto-dismiss', () => {
  it('shows a finite-duration toast in the DOM and removes it after the timer fires', async () => {
    const { container } = render(<UiOverlay />)

    const toast: ToastState = { title: 'Done!', icon: 'success', duration: 1500, mask: false }
    act(() => { uiOverlayBus.showToast(toast) })

    expect(container.querySelector('[role="alert"]')).not.toBeNull()

    // Advance past the 1500ms auto-dismiss timer
    act(() => { vi.advanceTimersByTime(1500) })

    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps a showLoading toast (Infinity duration) present after advancing time', async () => {
    const { container } = render(<UiOverlay />)

    const loading: ToastState = { title: 'Loading…', icon: 'loading', duration: Infinity, mask: false }
    act(() => { uiOverlayBus.showToast(loading) })

    expect(container.querySelector('[role="alert"]')).not.toBeNull()

    // Advance a large amount — the Infinity timer must never fire
    act(() => { vi.advanceTimersByTime(60_000) })

    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })
})

// ─── Stale-timer safety ───────────────────────────────────────────────────────

describe('UiOverlay — stale-timer safety', () => {
  it("t1's stale timer does not clear t2 when it fires after t2 has replaced t1", () => {
    const { container } = render(<UiOverlay />)

    const t1: ToastState = { title: 'first', icon: 'success', duration: 1500, mask: false }
    const t2: ToastState = { title: 'second', icon: 'none', duration: 3000, mask: false }

    act(() => { uiOverlayBus.showToast(t1) })
    expect(container.querySelector('[role="alert"]')).not.toBeNull()

    // After 1000ms a NEW toast replaces t1; t1's timer is scheduled to fire at 1500ms
    act(() => { vi.advanceTimersByTime(1000) })
    act(() => { uiOverlayBus.showToast(t2) })

    // Advance 600ms more — t1's original timer (at 1500ms from t1 show) would fire here
    act(() => { vi.advanceTimersByTime(600) })

    // t2 must still be shown: the stale t1 timer called dismissToast(t1) which is a no-op
    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    // Verify the text: t2's title should be visible
    expect(container.textContent).toContain('second')
  })
})

// ─── Modal ───────────────────────────────────────────────────────────────────

describe('UiOverlay — modal dialog', () => {
  it('renders a modal when pushed via the bus and calls onResult(true) on confirm click', () => {
    render(<UiOverlay />)

    const onResult = vi.fn()
    act(() => {
      uiOverlayBus.showDialog({
        kind: 'modal',
        title: 'Delete?',
        content: 'This cannot be undone.',
        showCancel: true,
        cancelText: '取消',
        cancelColor: '#000000',
        confirmText: '确定',
        confirmColor: '#576B95',
        editable: false,
        placeholderText: '',
        onResult,
      })
    })

    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeDefined()

    // Click the confirm button
    const confirmBtn = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent === '确定',
    )
    expect(confirmBtn).toBeDefined()
    act(() => { confirmBtn!.click() })

    expect(onResult).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith(true, '')
  })

  it('renders a .dmui-mask overlay when a modal is open', () => {
    const { container } = render(<UiOverlay />)

    act(() => {
      uiOverlayBus.showDialog({
        kind: 'modal',
        title: 'Alert',
        content: '',
        showCancel: false,
        cancelText: '取消',
        cancelColor: '#000000',
        confirmText: 'OK',
        confirmColor: '#576B95',
        editable: false,
        placeholderText: '',
        onResult: vi.fn(),
      })
    })

    // jsdom does not load CSS, but the className is still in the DOM
    expect(container.querySelector('.dmui-mask')).not.toBeNull()
  })
})
