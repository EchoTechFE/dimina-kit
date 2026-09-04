/**
 * `handleEdit`'s host-hook branch (Main's project-list screen).
 *
 * `openEditProjectDialog`'s reply is a 3-way discriminator and each shape
 * drives a different UI outcome:
 *  - `null`               → no hook configured; open the built-in dialog.
 *  - `{ result: null }`   → hook ran, user cancelled; do nothing (must NOT
 *    also open the built-in dialog — that would double-prompt).
 *  - `{ result: { updated } }` → host already persisted the edit; just
 *    refresh the list, never call `updateProject` again.
 *  - `{ result: patch }`  → apply the patch via `updateProject`, then
 *    refresh the list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { Project } from '@/shared/types'
import type { OpenEditProjectDialogReply } from '../../../shared/types'

const project: Project = { name: 'Alpha', path: '/abs/alpha', lastOpened: null }

const api = vi.hoisted(() => ({
  listProjects: vi.fn(),
  getThumbnail: vi.fn(),
  getBranding: vi.fn(),
  onWindowNavigateBack: vi.fn(() => () => {}),
  onWindowOpenProject: vi.fn(() => () => {}),
  onProjectCreateSubmitted: vi.fn(() => () => {}),
  openEditProjectDialog: vi.fn(),
  updateProject: vi.fn(),
  publishPlacementSnapshot: vi.fn(() => Promise.resolve()),
  onHostSidebarWidthChanged: vi.fn(() => () => {}),
  getHostSidebarWidth: vi.fn(() => Promise.resolve(0)),
  onHostSidebarCategorySelected: vi.fn(() => () => {}),
}))

vi.mock('@/shared/api', () => api)
vi.mock('@dimina-kit/view-anchor', () => ({ useViewAnchor: () => () => {} }))

import Main from './main'

async function renderMainWithProject() {
  const result = render(<Main />)
  await screen.findByText('Alpha')
  return result
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listProjects.mockResolvedValue([project])
  api.getThumbnail.mockResolvedValue(null)
  api.getBranding.mockResolvedValue(undefined)
  api.getHostSidebarWidth.mockResolvedValue(0)
  api.updateProject.mockResolvedValue({ ...project, name: 'Renamed' })
})

function openEditForAlpha() {
  const card = screen.getByText('Alpha').closest('[data-qd-card]')!
  fireEvent.mouseEnter(card)
  fireEvent.click(screen.getByRole('button', { name: '编辑 Alpha' }))
}

describe('Main.handleEdit', () => {
  it('opens the built-in dialog when openEditProjectDialog resolves null (no hook configured)', async () => {
    api.openEditProjectDialog.mockResolvedValue(null satisfies OpenEditProjectDialogReply)
    await renderMainWithProject()

    openEditForAlpha()

    await screen.findByLabelText('项目名称')
    expect(api.updateProject).not.toHaveBeenCalled()
  })

  it('does nothing when the reply is { result: null } (host hook ran, user cancelled) — no built-in dialog, no update', async () => {
    api.openEditProjectDialog.mockResolvedValue({ result: null } satisfies OpenEditProjectDialogReply)
    await renderMainWithProject()

    openEditForAlpha()

    await waitFor(() => expect(api.openEditProjectDialog).toHaveBeenCalled())
    expect(screen.queryByLabelText('项目名称')).not.toBeInTheDocument()
    expect(api.updateProject).not.toHaveBeenCalled()
  })

  it('refreshes the list without calling updateProject when the reply is { result: { updated } }', async () => {
    api.openEditProjectDialog.mockResolvedValue({
      result: { updated: { ...project, name: 'Renamed' } },
    } satisfies OpenEditProjectDialogReply)
    await renderMainWithProject()
    const callsBefore = api.listProjects.mock.calls.length

    openEditForAlpha()

    await waitFor(() =>
      expect(api.listProjects.mock.calls.length).toBeGreaterThan(callsBefore),
    )
    expect(api.updateProject).not.toHaveBeenCalled()
  })

  it('applies the patch via updateProject and refreshes the list when the reply is { result: patch }', async () => {
    api.openEditProjectDialog.mockResolvedValue({
      result: { name: 'Renamed' },
    } satisfies OpenEditProjectDialogReply)
    await renderMainWithProject()
    const callsBefore = api.listProjects.mock.calls.length

    openEditForAlpha()

    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith('/abs/alpha', { name: 'Renamed' }),
    )
    await waitFor(() =>
      expect(api.listProjects.mock.calls.length).toBeGreaterThan(callsBefore),
    )
  })

  it('keeps the built-in dialog open and shows the error when updateProject rejects', async () => {
    api.openEditProjectDialog.mockResolvedValue(null)
    api.updateProject.mockRejectedValue(new Error('当前宿主不支持编辑项目'))
    await renderMainWithProject()

    openEditForAlpha()
    await screen.findByLabelText('项目名称')
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await screen.findByText('当前宿主不支持编辑项目')
    expect(screen.getByLabelText('项目名称')).toBeInTheDocument()
  })

  it('reflects the updated record on the card immediately, without waiting for the post-save reload', async () => {
    api.openEditProjectDialog.mockResolvedValue(null)
    api.updateProject.mockResolvedValue({ ...project, name: 'Renamed' })
    // The reload that handleEditSubmit fires after closing the dialog is
    // held open here and kept resolving the stale record, simulating a
    // provider that is only eventually consistent — the card must already
    // show the new name before that reload ever settles.
    let resolveReload: (projects: Project[]) => void = () => {}
    const reloadPromise = new Promise<Project[]>((resolve) => {
      resolveReload = resolve
    })
    api.listProjects.mockResolvedValueOnce([project]).mockImplementation(() => reloadPromise)
    await renderMainWithProject()

    openEditForAlpha()
    await screen.findByLabelText('项目名称')
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await screen.findByText('Renamed')
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()

    resolveReload([project])
  })
})
