import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, fireEvent, screen } from '@testing-library/react'
import { ProjectToolbar } from './project-toolbar'
import type { LayoutStoreApi } from '../controllers/use-layout-store'

type HeaderAvatar = {
  displayName?: string
  displayInitial?: string
  avatarUrl?: string
  tooltip?: string
}

type HeaderAction = {
  id: string
  label: string
  placement?: 'left' | 'center' | 'right'
}

const api = vi.hoisted(() => {
  const store = {
    listener: null as null | (() => void),
    unsubscribe: vi.fn(),
  }
  return {
    store,
    mocks: {
      getHeaderAvatar: vi.fn<() => Promise<HeaderAvatar | null>>(() => Promise.resolve(null)),
      onHeaderAvatarChanged: vi.fn((handler: () => void) => {
        store.listener = handler
        return store.unsubscribe
      }),
      invokeHeaderAvatar: vi.fn(() => Promise.resolve()),
      getHeaderActions: vi.fn<() => Promise<HeaderAction[]>>(() => Promise.resolve([])),
      invokeHeaderAction: vi.fn(() => Promise.resolve()),
      onHeaderActionsChanged: vi.fn(() => () => {}),
      setSettingsVisible: vi.fn(() => Promise.resolve()),
      getToolbarActions: vi.fn(() => Promise.resolve([])),
      invokeToolbarAction: vi.fn(() => Promise.resolve()),
      onToolbarActionsChanged: vi.fn(() => () => {}),
    },
  }
})

vi.mock('@/shared/api', () => api.mocks)

function makeLayoutStub(): LayoutStoreApi {
  return {
    state: {
      simulatorVisible: true,
      editorVisible: true,
      debugVisible: true,
      simulatorAlignment: 'left',
      devtoolsPosition: 'inEditor',
    },
    visibleCount: 3,
    toggleSimulator: vi.fn(),
    toggleEditor: vi.fn(),
    toggleDebug: vi.fn(),
    setSimulatorAlignment: vi.fn(),
    setDevtoolsPosition: vi.fn(),
  }
}

async function renderToolbar() {
  const utils = render(
    <ProjectToolbar
      compileDropdownRef={React.createRef<HTMLDivElement>()}
      showCompilePanel={false}
      onToggleCompilePanel={() => {}}
      onRelaunch={() => {}}
      compileStatus={{ status: 'ready', message: '' }}
      layout={makeLayoutStub()}
    />,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return utils
}

beforeEach(() => {
  api.store.listener = null
  api.store.unsubscribe.mockClear()
  api.mocks.getHeaderAvatar.mockReset()
  api.mocks.getHeaderAvatar.mockResolvedValue(null)
  api.mocks.onHeaderAvatarChanged.mockClear()
  api.mocks.invokeHeaderAvatar.mockClear()
  api.mocks.getHeaderActions.mockReset()
  api.mocks.getHeaderActions.mockResolvedValue([])
  api.mocks.invokeHeaderAction.mockClear()
  api.mocks.onHeaderActionsChanged.mockClear()
})

describe('ProjectToolbar header avatar slot', () => {
  it('renders the host-provided avatar DTO in the fixed header toolbar', async () => {
    api.mocks.getHeaderAvatar.mockResolvedValueOnce({
      displayName: 'Ada Lovelace',
      avatarUrl: 'https://example.com/avatar.png',
    })

    await renderToolbar()

    const avatar = screen.getByRole('button', { name: 'Ada Lovelace' })
    const compileButton = screen.getByRole('button', { name: /普通编译/ })

    expect(avatar).toBeInTheDocument()
    expect(avatar.querySelector('img')?.getAttribute('src')).toBe('https://example.com/avatar.png')
    expect(
      avatar.compareDocumentPosition(compileButton),
      'the account avatar must sit at the far left of the fixed header toolbar, before compile controls',
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('uses displayInitial as the fallback when no image URL is provided', async () => {
    api.mocks.getHeaderAvatar.mockResolvedValueOnce({
      displayName: 'Qdmp User',
      displayInitial: 'QU',
    })

    await renderToolbar()

    expect(screen.getByRole('button', { name: 'Qdmp User' })).toHaveTextContent('Q')
  })

  it('invokes the host avatar action when clicked', async () => {
    api.mocks.getHeaderAvatar.mockResolvedValueOnce({
      displayName: 'Qdmp User',
      avatarUrl: 'https://example.com/avatar.png',
    })

    await renderToolbar()

    fireEvent.click(screen.getByRole('button', { name: 'Qdmp User' }))

    expect(api.mocks.invokeHeaderAvatar).toHaveBeenCalledTimes(1)
  })

  it('renders host header actions and invokes the selected action id', async () => {
    api.mocks.getHeaderActions.mockResolvedValueOnce([
      { id: 'preview', label: '预览', placement: 'center' },
      { id: 'upload', label: '上传', placement: 'right' },
    ])

    await renderToolbar()

    fireEvent.click(screen.getByRole('button', { name: '上传' }))

    expect(api.mocks.invokeHeaderAction).toHaveBeenCalledWith('upload')
  })

  it('re-fetches the avatar when the main process announces a profile change', async () => {
    api.mocks.getHeaderAvatar
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ displayName: 'Grace Hopper' })

    await renderToolbar()
    expect(screen.queryByRole('button', { name: 'Grace Hopper' })).toBeNull()
    expect(api.store.listener, 'ProjectToolbar must subscribe to avatar change events').toBeTruthy()

    await act(async () => {
      api.store.listener?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole('button', { name: 'Grace Hopper' })).toBeInTheDocument()
  })
})
