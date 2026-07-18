/**
 * Regression: install() resolves `{success:false, error}` on a failed
 * shell.openPath() (not a rejection — see update-manager.ts). Before this
 * fix, handleInstall only had a `.catch()` and never inspected the resolved
 * value, so a failed install left the dialog stuck showing "Ready to
 * Install" forever with no feedback and no way to retry.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeStrictMock, onMock, listeners } = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  return {
    invokeStrictMock: vi.fn(),
    onMock: vi.fn((channel: string, cb: (...args: unknown[]) => void) => {
      listeners.set(channel, cb)
      return () => listeners.delete(channel)
    }),
    listeners,
  }
})

vi.mock('@/shared/api/ipc-transport', () => ({
  invokeStrict: invokeStrictMock,
  on: onMock,
}))

import { UpdateChannel } from '../../../shared/ipc-channels.js'
import { UpdateDialog } from './update-dialog'

const UPDATE_INFO = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.dmg' }

beforeEach(() => {
  invokeStrictMock.mockReset()
  listeners.clear()
})

async function openAndDownload() {
  render(<UpdateDialog />)
  act(() => { listeners.get(UpdateChannel.Available)!(UPDATE_INFO) })
  invokeStrictMock.mockResolvedValueOnce({ success: true })
  fireEvent.click(await screen.findByRole('button', { name: 'Download' }))
  await screen.findByRole('button', { name: 'Install & Restart' })
}

describe('UpdateDialog: install failure feedback', () => {
  it('shows the install error (not "Download failed") when install() resolves success:false', async () => {
    await openAndDownload()
    invokeStrictMock.mockResolvedValueOnce({ success: false, error: 'no application associated with this file' })

    fireEvent.click(screen.getByRole('button', { name: 'Install & Restart' }))

    await waitFor(() => {
      expect(screen.getByText('Install failed: no application associated with this file')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('Retry after an install failure retries install(), not a fresh download()', async () => {
    await openAndDownload()
    invokeStrictMock.mockResolvedValueOnce({ success: false, error: 'boom' })
    fireEvent.click(screen.getByRole('button', { name: 'Install & Restart' }))
    await screen.findByRole('button', { name: 'Retry' })

    invokeStrictMock.mockClear()
    invokeStrictMock.mockResolvedValueOnce({ success: true })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => {
      expect(invokeStrictMock).toHaveBeenCalledWith(UpdateChannel.Install)
    })
    expect(invokeStrictMock).not.toHaveBeenCalledWith(UpdateChannel.Download)
  })

  it('a download failure still labels itself "Download failed" and Retry re-downloads', async () => {
    render(<UpdateDialog />)
    act(() => { listeners.get(UpdateChannel.Available)!(UPDATE_INFO) })
    invokeStrictMock.mockResolvedValueOnce({ success: false, error: 'network error' })

    fireEvent.click(await screen.findByRole('button', { name: 'Download' }))

    await waitFor(() => {
      expect(screen.getByText('Download failed: network error')).toBeInTheDocument()
    })

    invokeStrictMock.mockClear()
    invokeStrictMock.mockResolvedValueOnce({ success: true })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => {
      expect(invokeStrictMock).toHaveBeenCalledWith(UpdateChannel.Download)
    })
  })
})
