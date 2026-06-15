/**
 * Wave 2 decommission — renderer half of the host-toolbar-buttons removal.
 * `instance.toolbar.set()` is deleted in main, so ProjectToolbar must stop
 * (a) rendering the host-actions row and (b) talking to the toolbar IPC
 * cluster ('toolbar:getActions' / 'toolbar:actionsChanged').
 *
 * Real bug each test catches:
 *  - "no host action button renders": the implementer removes the main-side
 *    surface but leaves the renderer row — the mock simulates a stale main
 *    process still answering GetActions with one action; if the row survives,
 *    a phantom button renders whose click drives the deleted
 *    'toolbar:invoke' channel (rejects on every click).
 *  - "never calls getToolbarActions": catches the half-fix that keeps the
 *    mount-effect fetch but hides the row — the channel no longer exists in
 *    main, so every ProjectToolbar mount fires a rejected invoke and keeps a
 *    dead dependency on the removed channel.
 *  - "never subscribes onToolbarActionsChanged": a leftover subscription is a
 *    listener for an event main can never send again — dead wire surface that
 *    invites the cluster to grow back.
 *
 * The `@/shared/api` mock is built with vi.hoisted and keeps stubs for the
 * toolbar exports even after the real exports are deleted, so this file needs
 * no edits when the implementation lands (same pattern as
 * project-toolbar-fixed-header.test.tsx).
 *
 * RED today: project-toolbar.tsx fetches getToolbarActions() in a mount
 * effect, subscribes onToolbarActionsChanged, and renders the actions row.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { ProjectToolbar } from './project-toolbar'
import type { LayoutStoreApi } from '../controllers/use-layout-store'

const apiMocks = vi.hoisted(() => ({
  // Simulates a stale main process that still answers GetActions with one
  // host action. If the component still consults the legacy IPC, this action
  // materializes as a phantom button and the assertions below catch it.
  getToolbarActions: vi.fn(() => Promise.resolve([{ id: 'host-a', label: 'HOST_ACTION_SENTINEL' }])),
  invokeToolbarAction: vi.fn(() => Promise.resolve()),
  onToolbarActionsChanged: vi.fn(() => () => {}),
  // Wave 2 ④ — the settings entry point the toolbar gains; present so the
  // component's (future) import resolves. Not asserted here.
  setSettingsVisible: vi.fn(() => Promise.resolve()),
  getHeaderAvatar: vi.fn(() => Promise.resolve(null)),
  onHeaderAvatarChanged: vi.fn(() => () => {}),
  invokeHeaderAvatar: vi.fn(() => Promise.resolve()),
  getHeaderActions: vi.fn(() => Promise.resolve([])),
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
      compileStatus={{ status: 'ready', message: '' }}
      layout={makeLayoutStub()}
    />,
  )
  // Flush mount effects + pending IPC promise resolutions so a legacy
  // fetch-then-setState(actions) has every chance to paint before we assert.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return utils
}

describe('host-toolbar-buttons decommission: ProjectToolbar drops the host actions row', () => {
  it('renders NO host action button even when the legacy IPC would supply one', async () => {
    const { queryByText } = await renderToolbar()
    expect(
      queryByText('HOST_ACTION_SENTINEL'),
      'the host-actions row must be gone — a rendered host button means the row survived and its click would drive the deleted toolbar:invoke channel',
    ).toBeNull()
  })

  it('never calls the legacy getToolbarActions IPC on mount', async () => {
    apiMocks.getToolbarActions.mockClear()
    await renderToolbar()
    expect(
      apiMocks.getToolbarActions,
      "ProjectToolbar must not invoke 'toolbar:getActions' — the channel is decommissioned and the call would reject on every mount",
    ).not.toHaveBeenCalled()
  })

  it('never subscribes to the legacy onToolbarActionsChanged event', async () => {
    apiMocks.onToolbarActionsChanged.mockClear()
    await renderToolbar()
    expect(
      apiMocks.onToolbarActionsChanged,
      "ProjectToolbar must not listen for 'toolbar:actionsChanged' — main has no sender left; a leftover subscription is dead wire surface inviting the cluster back",
    ).not.toHaveBeenCalled()
  })
})
