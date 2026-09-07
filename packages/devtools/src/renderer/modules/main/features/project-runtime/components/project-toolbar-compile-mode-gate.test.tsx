/**
 * The compile-mode button opens a main-process popover that reads the
 * CompileModeStore via `getCompileModeState` (see use-session.ts). Before
 * `useSession` has adopted an initial store snapshot (or a
 * `onCompileModesChanged` push), that store may not exist yet for this
 * project — clicking through to it would surface an error instead of a
 * usable menu. `compileModesReady` (surfaced by useSession, threaded through
 * project-runtime.tsx → ProjectToolbar) gates the button so it cannot be
 * clicked before there is state to show.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { ProjectToolbar } from './project-toolbar'
import { buildDockModel, buildDockRegistry } from '../layout/dock-layout'

const apiMocks = vi.hoisted(() => ({
  getToolbarActions: vi.fn(() => Promise.resolve([])),
  invokeToolbarAction: vi.fn(() => Promise.resolve()),
  onToolbarActionsChanged: vi.fn(() => () => {}),
  setSettingsVisible: vi.fn(() => Promise.resolve()),
  prepareTooltip: vi.fn(),
}))

vi.mock('@/shared/api', () => apiMocks)

async function renderToolbar(compileModesReady: boolean) {
  const utils = render(
    <ProjectToolbar
      compileDropdownRef={React.createRef<HTMLDivElement>()}
      compileModeLabel="普通编译"
      showCompilePanel={false}
      onToggleCompilePanel={() => {}}
      compileModesReady={compileModesReady}
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

describe('ProjectToolbar: compile-mode button is gated on compileModesReady', () => {
  it('is disabled while the store snapshot has not been adopted yet', async () => {
    const { container } = await renderToolbar(false)
    const button = container.querySelector<HTMLButtonElement>('[data-testid="compile-mode-button"]')
    expect(
      button,
      'compile-mode button must exist regardless of readiness',
    ).not.toBeNull()
    expect(
      button!.disabled,
      'clicking before a store snapshot exists would surface a main-process error instead of a usable menu — the button must be disabled until compileModesReady is true',
    ).toBe(true)
  })

  it('is enabled once a store snapshot (or push) has been adopted', async () => {
    const { container } = await renderToolbar(true)
    const button = container.querySelector<HTMLButtonElement>('[data-testid="compile-mode-button"]')
    expect(button).not.toBeNull()
    expect(button!.disabled).toBe(false)
  })
})
