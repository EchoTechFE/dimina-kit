/**
 * Settings entry point in the toolbar.
 *
 * CONTRACT:
 *  - ProjectToolbar renders a STATELESS settings button with `title="设置"`
 *    (title is how every icon button in this toolbar exposes its accessible
 *    name — cf. the 重新编译 button).
 *  - Clicking it calls the renderer wrapper `setSettingsVisible(true)`
 *    from `@/shared/api` (settings-api.ts), which drives the
 *    'settings:setVisible' main handler → views.showSettings() +
 *    notify.settingsInit(). Open-only: the overlay owns its own close path,
 *    the button carries no open/closed state.
 *
 * Real bug each test catches:
 *  - "button exists": without the button the settings overlay has NO UI entry
 *    point (only raw IPC), so users cannot reach project settings at all.
 *  - "click → setSettingsVisible(true)": catches a button wired to nothing,
 *    wired to the WRONG surface (e.g. the standalone workbench-settings
 *    window instead of the embedded project-settings overlay), or calling
 *    with `false`/no argument — the main handler branches on the boolean, so
 *    a missing `true` HIDES the overlay instead of showing it.
 *
 * The `@/shared/api` mock keeps stubs for the legacy toolbar exports so this
 * file renders against the component.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import { ProjectToolbar } from './project-toolbar'
import { buildDockModel, buildDockRegistry } from '../layout/dock-layout'

const apiMocks = vi.hoisted(() => ({
  // Legacy toolbar exports — kept as inert stubs so the component renders.
  getToolbarActions: vi.fn(() => Promise.resolve([])),
  invokeToolbarAction: vi.fn(() => Promise.resolve()),
  onToolbarActionsChanged: vi.fn(() => () => {}),
  // The contract under test.
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
    />,
  )
  await act(async () => {
    await Promise.resolve()
  })
  return utils
}

describe('settings entry point: ProjectToolbar gains a 设置 button', () => {
  it('renders a button titled 设置', async () => {
    const { container } = await renderToolbar()
    const button = container.querySelector('button[title="设置"]')
    expect(
      button,
      'the toolbar must expose a settings entry point — without it the embedded project-settings overlay is unreachable from the UI (only raw IPC could open it)',
    ).not.toBeNull()
  })

  it('clicking it opens the embedded settings overlay via setSettingsVisible(true)', async () => {
    const { container } = await renderToolbar()
    const button = container.querySelector<HTMLButtonElement>('button[title="设置"]')
    expect(button, 'settings button must exist (see previous test)').not.toBeNull()

    apiMocks.setSettingsVisible.mockClear()
    await act(async () => {
      fireEvent.click(button!)
      await Promise.resolve()
    })

    expect(
      apiMocks.setSettingsVisible,
      "the click must drive the embedded overlay's 'settings:setVisible' path — a button wired to nothing (or to the standalone workbench-settings window) leaves project settings unreachable",
    ).toHaveBeenCalledTimes(1)
    expect(
      apiMocks.setSettingsVisible,
      'must pass `true` — the main handler branches on the boolean and `false` HIDES the overlay',
    ).toHaveBeenCalledWith(true)
  })

  it('the button is stateless open-only: a second click opens again (no toggle-to-close)', async () => {
    const { container } = await renderToolbar()
    const button = container.querySelector<HTMLButtonElement>('button[title="设置"]')
    expect(button).not.toBeNull()

    apiMocks.setSettingsVisible.mockClear()
    await act(async () => {
      fireEvent.click(button!)
      fireEvent.click(button!)
      await Promise.resolve()
    })

    // A toggle implementation would send `false` on the second click — but the
    // button has no way to observe the overlay's real state (the Closed
    // notification has no renderer consumer by design), so a toggle would
    // desync and "close" an already-closed overlay while the user expects it
    // to open.
    expect(apiMocks.setSettingsVisible).toHaveBeenNthCalledWith(1, true)
    expect(apiMocks.setSettingsVisible).toHaveBeenNthCalledWith(2, true)
  })
})
