/**
 * Main no longer switches to an in-tree `ProjectRuntime` page — opening a
 * project asks main to spawn a standalone workbench window instead, and the
 * list screen stays mounted throughout (see entries/workbench/main.tsx for
 * the window that renders `ProjectRuntime`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { Project } from '@/shared/types'

const project: Project = { name: 'Alpha', path: '/abs/alpha', lastOpened: null }

const api = vi.hoisted(() => ({
  listProjects: vi.fn(),
  getThumbnail: vi.fn(),
  getBranding: vi.fn(),
  onWindowNavigateBack: vi.fn((_handler: () => void) => () => {}),
  onWindowOpenProject: vi.fn((_handler: (p: { name: string; path: string }) => void) => () => {}),
  onProjectCreateSubmitted: vi.fn(() => () => {}),
  openProjectWindow: vi.fn(() => Promise.resolve()),
  publishPlacementSnapshot: vi.fn(() => Promise.resolve()),
  onHostSidebarWidthChanged: vi.fn(() => () => {}),
  getHostSidebarWidth: vi.fn(() => Promise.resolve(0)),
  onHostSidebarCategorySelected: vi.fn(() => () => {}),
}))

vi.mock('@/shared/api', () => api)
vi.mock('@dimina-kit/view-anchor', () => ({ useViewAnchor: () => () => {} }))

import Main from './main'

beforeEach(() => {
  vi.clearAllMocks()
  api.listProjects.mockResolvedValue([project])
  api.getThumbnail.mockResolvedValue(null)
  api.getBranding.mockResolvedValue(undefined)
  api.getHostSidebarWidth.mockResolvedValue(0)
})

async function renderMainWithProject() {
  const result = render(<Main />)
  await screen.findByText('Alpha')
  return result
}

describe('Main: opening a project spawns a workbench window instead of switching pages', () => {
  it('clicking a project card asks main to open a workbench window, and the list stays mounted', async () => {
    await renderMainWithProject()

    fireEvent.click(screen.getByText('Alpha').closest('[data-qd-card]')!)

    expect(api.openProjectWindow).toHaveBeenCalledWith(project)
    // No in-tree page switch: the list screen (and this card) is still there.
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  it('forwards a main-pushed open (MCP project_open) to openProjectWindow', async () => {
    await renderMainWithProject()
    const pushHandler = api.onWindowOpenProject.mock.calls[0][0]

    pushHandler({ name: 'Beta', path: '/abs/beta' })

    expect(api.openProjectWindow).toHaveBeenCalledWith({ name: 'Beta', path: '/abs/beta' })
  })

  it('refreshes the project list when a workbench window reports navigate-back (its close)', async () => {
    await renderMainWithProject()
    const navigateBackHandler = api.onWindowNavigateBack.mock.calls[0][0]
    const callsBefore = api.listProjects.mock.calls.length

    navigateBackHandler()

    await waitFor(() =>
      expect(api.listProjects.mock.calls.length).toBeGreaterThan(callsBefore),
    )
  })
})
