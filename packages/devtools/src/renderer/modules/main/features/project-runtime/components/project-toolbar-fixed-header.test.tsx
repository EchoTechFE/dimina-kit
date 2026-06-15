/**
 * headerHeight decommission — renderer half. The ProjectToolbar main row
 * must render at the fixed HEADER_H constant (40px) and must NOT consult
 * the legacy `app:getHeaderHeight` IPC. Host actions live in their own
 * auto-height row, so the deprecated host config has no renderer effect.
 *
 * Real bug each test catches:
 *  - "height stays 40": the implementer leaves the
 *    `useState(HEADER_H)` + `getHeaderHeight().then(setHeaderHeight)`
 *    wiring in project-toolbar.tsx — the row first paints 40 and then
 *    flips to whatever the IPC reports (72 here), desyncing from the main
 *    process layout that now carves views at the constant 40.
 *  - "never calls the IPC": catches the half-fix that keeps the
 *    getHeaderHeight() call but clamps/ignores its value — the channel no
 *    longer exists in main, so the call would reject on every mount and
 *    keep a dead dependency on the removed `app:getHeaderHeight` channel.
 *
 * The `@/shared/api` mock is built with vi.hoisted and keeps a
 * `getHeaderHeight` stub even after the real export is deleted, so this
 * file needs no edits when the implementation lands.
 *
 * RED today: project-toolbar.tsx fetches getHeaderHeight() in a mount
 * effect and renders `style={{ height: headerHeight }}` with the fetched 72.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { HEADER_H } from '@/shared/constants'
import { ProjectToolbar } from './project-toolbar'
import type { LayoutStoreApi } from '../controllers/use-layout-store'

const apiMocks = vi.hoisted(() => ({
  // Simulates a host that configured the (now deprecated) headerHeight: 72.
  // If the component still consults the legacy IPC, this value leaks into
  // the rendered row height and the assertions below catch it.
  getHeaderHeight: vi.fn(() => Promise.resolve(72)),
  getToolbarActions: vi.fn(() => Promise.resolve([])),
  invokeToolbarAction: vi.fn(() => Promise.resolve()),
  onToolbarActionsChanged: vi.fn(() => () => {}),
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
  // Flush mount effects + any pending IPC promise resolutions so a legacy
  // post-fetch setState (40 → 72) has every chance to fire before we assert.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return utils
}

/** The main toolbar row is the only element with an inline height style. */
function findHeaderRow(container: HTMLElement): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>('div')).find(
    (el) => el.style.height !== '',
  )
  expect(row, 'expected the toolbar main row to carry an inline height style').toBeDefined()
  return row!
}

describe('headerHeight decommission: ProjectToolbar main row is fixed at HEADER_H', () => {
  it('renders 40px even when the legacy IPC would report a host-configured 72', async () => {
    const { container } = await renderToolbar()
    const row = findHeaderRow(container)
    expect(HEADER_H, 'HEADER_H constant itself must stay 40').toBe(40)
    expect(
      row.style.height,
      'the main row height must be the HEADER_H constant — a 72px reading means the legacy IPC value still drives the layout',
    ).toBe(`${HEADER_H}px`)
  })

  it('never calls the legacy getHeaderHeight IPC on mount', async () => {
    apiMocks.getHeaderHeight.mockClear()
    await renderToolbar()
    expect(
      apiMocks.getHeaderHeight,
      'ProjectToolbar must not invoke app:getHeaderHeight — the channel is decommissioned and the call would reject on every mount',
    ).not.toHaveBeenCalled()
  })
})
