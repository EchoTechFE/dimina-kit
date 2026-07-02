/**
 * ProjectToolbar must NOT (a) render the host-actions row or (b) talk to the
 * toolbar IPC cluster ('toolbar:getActions' / 'toolbar:actionsChanged'):
 * `instance.toolbar.set()` no longer exists in main.
 *
 * Real bug each test catches:
 *  - "no host action button renders": the mock simulates a stale main process
 *    still answering GetActions with one action; if the row survives, a phantom
 *    button renders whose click drives the deleted 'toolbar:invoke' channel
 *    (rejects on every click).
 *  - "never calls getToolbarActions": catches keeping the mount-effect fetch
 *    but hiding the row — the channel no longer exists in main, so every
 *    ProjectToolbar mount would fire a rejected invoke and keep a dead
 *    dependency on the removed channel.
 *  - "never subscribes onToolbarActionsChanged": a leftover subscription is a
 *    listener for an event main can never send again — dead wire surface that
 *    invites the cluster to grow back.
 *
 * The `@/shared/api` mock is built with vi.hoisted and keeps stubs for the
 * toolbar exports even though the real exports are gone (same pattern as
 * project-toolbar-fixed-header.test.tsx).
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { ProjectToolbar } from './project-toolbar'
import { buildDockModel, buildDockRegistry } from '../layout/dock-layout'

const apiMocks = vi.hoisted(() => ({
  // Simulates a stale main process that still answers GetActions with one
  // host action. If the component still consults the legacy IPC, this action
  // materializes as a phantom button and the assertions below catch it.
  getToolbarActions: vi.fn(() => Promise.resolve([{ id: 'host-a', label: 'HOST_ACTION_SENTINEL' }])),
  invokeToolbarAction: vi.fn(() => Promise.resolve()),
  onToolbarActionsChanged: vi.fn(() => () => {}),
  // The settings entry point the toolbar uses; present so the component's
  // import resolves. Not asserted here.
  setSettingsVisible: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/shared/api', () => apiMocks)

async function renderToolbar() {
  const utils = render(
    <ProjectToolbar
      compileDropdownRef={React.createRef<HTMLDivElement>()}
      showCompilePanel={false}
      onToggleCompilePanel={() => {}}
      onRelaunch={() => {}}
      compileStatus={{ status: 'ready', message: '' }}
      dockModel={buildDockModel(null, 375, new Set())}
      dockRegistry={buildDockRegistry()}
      layout={{
        state: { dockTree: null, simulatorAlignment: 'left', devtoolsPosition: 'inEditor' },
        setDockTree: () => {},
        setSimulatorAlignment: () => {},
        setDevtoolsPosition: () => {},
      }}
      simPanelWidth={375}
      launchConfigs={[]}
      activeLaunchConfigId={null}
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
