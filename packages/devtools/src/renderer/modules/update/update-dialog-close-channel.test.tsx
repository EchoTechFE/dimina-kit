/**
 * Closing the update dialog (either the "Later"/"Close" button or
 * Escape/backdrop) must tell main to hide the WebContentsView overlay panel
 * it's presented in, not just call `setOpen(false)` on this renderer's own
 * DOM state — otherwise main never sees the close and the panel (a
 * full-window, click-eating overlay) stays presented forever after the
 * renderer has visually "closed".
 */
import { render, screen, fireEvent, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeStrictMock, sendMock, listeners } = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  return {
    invokeStrictMock: vi.fn(),
    sendMock: vi.fn(),
    listeners,
  }
})

vi.mock('@/shared/api/ipc-transport', () => ({
  invokeStrict: invokeStrictMock,
  on: vi.fn((channel: string, cb: (...args: unknown[]) => void) => {
    listeners.set(channel, cb)
    return () => listeners.delete(channel)
  }),
  send: sendMock,
}))

import { UpdateChannel } from '../../../shared/ipc-channels-overlays.js'
import { UpdateDialog } from './update-dialog'

const UPDATE_INFO = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.dmg' }

beforeEach(() => {
  invokeStrictMock.mockReset()
  sendMock.mockReset()
  listeners.clear()
})

describe('UpdateDialog: closing tells main to hide the overlay panel', () => {
  it('the "Later" button sends UpdateChannel.Close, not just a local setOpen(false)', async () => {
    render(<UpdateDialog />)
    act(() => { listeners.get(UpdateChannel.Available)!(UPDATE_INFO) })

    fireEvent.click(await screen.findByRole('button', { name: 'Later' }))

    expect(sendMock).toHaveBeenCalledWith(UpdateChannel.Close)
  })

  it('Escape (Radix onOpenChange) also sends UpdateChannel.Close', async () => {
    render(<UpdateDialog />)
    act(() => { listeners.get(UpdateChannel.Available)!(UPDATE_INFO) })
    await screen.findByRole('button', { name: 'Later' })

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' })

    expect(sendMock).toHaveBeenCalledWith(UpdateChannel.Close)
  })
})
