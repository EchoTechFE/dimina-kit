import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'

const apiMocks = vi.hoisted(() => ({
  setSettingsVisible: vi.fn(() => Promise.resolve()),
  onSettingsInit: vi.fn((_cb: (payload: unknown) => void) => () => {}),
  emitProjectSettingsChanged: vi.fn(),
  emitSettingsConfigChanged: vi.fn(),
}))

vi.mock('@/shared/api', () => apiMocks)

import Settings from './settings'

describe('Settings: tab switching', () => {
  it('clicking 项目配置 switches the visible panel', () => {
    render(<Settings />)
    expect(screen.queryByText('本地目录')).toBeNull()
    const tab = screen.getByText('项目配置')
    fireEvent.pointerDown(tab)
    fireEvent.mouseDown(tab)
    fireEvent.mouseUp(tab)
    fireEvent.click(tab)
    expect(screen.queryByText('本地目录')).not.toBeNull()
  })
})
