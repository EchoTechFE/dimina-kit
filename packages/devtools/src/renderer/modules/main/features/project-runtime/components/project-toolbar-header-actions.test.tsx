import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, act, fireEvent, screen } from '@testing-library/react'
import { ProjectToolbar } from './project-toolbar'
import type { LayoutStoreApi } from '../controllers/use-layout-store'

const apiMocks = vi.hoisted(() => ({
  setSettingsVisible: vi.fn(() => Promise.resolve()),
  getHeaderAvatar: vi.fn(() => Promise.resolve(null)),
  onHeaderAvatarChanged: vi.fn(() => () => {}),
  invokeHeaderAvatar: vi.fn(() => Promise.resolve()),
  getHeaderActions: vi.fn(() => Promise.resolve([
    { id: 'open', label: '打开', placement: 'left' },
    { id: 'bindApp', label: '绑定应用', placement: 'left' },
    { id: 'preview', label: '真机预览', placement: 'center' },
    { id: 'upload', label: '上传', placement: 'right' },
  ])),
  onHeaderActionsChanged: vi.fn(() => () => {}),
  invokeHeaderAction: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/shared/api', () => apiMocks)

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
      compileStatus={{ status: 'ready', message: '编译完成' }}
      layout={makeLayoutStub()}
    />,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return utils
}

describe('ProjectToolbar header actions', () => {
  it('renders compact host actions inside the fixed header groups', async () => {
    await renderToolbar()

    const open = screen.getByRole('button', { name: '打开' })
    const bindApp = screen.getByRole('button', { name: '绑定应用' })
    const preview = screen.getByRole('button', { name: '真机预览' })
    const upload = screen.getByRole('button', { name: '上传' })
    const compile = screen.getByRole('button', { name: /普通编译/ })
    const settings = screen.getByTitle('设置')
    const debugToggle = screen.getByTestId('layout-toolbar-toggle-debug')
    const center = screen.getByTestId('project-toolbar-center')

    expect(debugToggle.compareDocumentPosition(open)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(open.compareDocumentPosition(bindApp)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(bindApp.compareDocumentPosition(compile)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(preview.compareDocumentPosition(settings)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(upload.compareDocumentPosition(settings)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(center).toHaveClass('flex-1')
    expect(center).toHaveClass('justify-center')
  })

  it('invokes the host action handler with the clicked id', async () => {
    await renderToolbar()

    fireEvent.click(screen.getByRole('button', { name: '上传' }))

    expect(apiMocks.invokeHeaderAction).toHaveBeenCalledWith('upload')
  })
})
