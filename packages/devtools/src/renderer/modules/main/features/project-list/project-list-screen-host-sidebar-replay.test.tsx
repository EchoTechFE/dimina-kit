/**
 * Host-sidebar width replay — renderer mount half (ProjectListScreen).
 *
 * Mirrors project-runtime-host-toolbar-replay.test.tsx on the inline axis:
 * the width chain is push-only and the sidebar WCV's size-advertiser
 * deduplicates (a width already reported is never re-sent), so a push that
 * fired before this screen mounted (cold start, or navigating back from a
 * project) is permanently lost unless the mount pulls the main-retained
 * value. Locked contract: subscribe BEFORE pulling; a push landing while the
 * pull is in flight wins over the stale pull result; an `undefined` pull
 * (swallowed ipc-transport error) keeps the placeholder at its seeded
 * default width without throwing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import { HOST_SIDEBAR_DEFAULT_WIDTH } from '@/shared/constants'

const api = vi.hoisted(() => {
  const widthListeners: Array<(width: number) => void> = []
  return {
    widthListeners,
    publishPlacementSnapshot: vi.fn(() => Promise.resolve()),
    onHostSidebarWidthChanged: vi.fn((handler: (width: number) => void) => {
      widthListeners.push(handler)
      return () => {
        const i = widthListeners.indexOf(handler)
        if (i >= 0) widthListeners.splice(i, 1)
      }
    }),
    getHostSidebarWidth: vi.fn((): Promise<number | undefined> => Promise.resolve(0)),
    onHostSidebarCategorySelected: vi.fn(() => () => {}),
  }
})

vi.mock('@/shared/api', () => ({
  publishPlacementSnapshot: api.publishPlacementSnapshot,
  onHostSidebarWidthChanged: api.onHostSidebarWidthChanged,
  getHostSidebarWidth: api.getHostSidebarWidth,
  onHostSidebarCategorySelected: api.onHostSidebarCategorySelected,
}))

// ProjectList itself is presentational and unrelated to the placeholder
// wiring under test here (covered by its own suites).
vi.mock('@/shared/components/project-list', () => ({ ProjectList: () => null }))

vi.mock('@dimina-kit/view-anchor', () => ({
  useViewAnchor: () => () => {},
}))

import { ProjectListScreen } from './project-list-screen'

function renderScreen() {
  return render(
    <ProjectListScreen
      projects={[]}
      onAdd={() => {}}
      onOpen={() => {}}
      onRemove={() => {}}
    />,
  )
}

function placeholderWidth(container: HTMLElement): string {
  const el = container.querySelector<HTMLElement>('[data-area="host-sidebar"]')
  expect(el, 'the [data-area="host-sidebar"] placeholder must render').not.toBeNull()
  return el!.style.width
}

function pushWidth(width: number): void {
  for (const listener of [...api.widthListeners]) listener(width)
}

beforeEach(() => {
  api.widthListeners.length = 0
  api.onHostSidebarWidthChanged.mockClear()
  api.getHostSidebarWidth.mockClear()
  api.getHostSidebarWidth.mockImplementation(() => Promise.resolve(0))
})

describe('ProjectListScreen: host-sidebar width replay on mount', () => {
  it('a live push after mount drives the placeholder', async () => {
    const { container } = renderScreen()

    expect(placeholderWidth(container)).toBe(`${HOST_SIDEBAR_DEFAULT_WIDTH}px`)
    await waitFor(() => expect(api.onHostSidebarWidthChanged).toHaveBeenCalled())

    act(() => pushWidth(240))
    await waitFor(() => expect(placeholderWidth(container)).toBe('240px'))
  })

  it('pulls the retained width on mount and applies it to the placeholder', async () => {
    api.getHostSidebarWidth.mockImplementation(() => Promise.resolve(240))

    const { container } = renderScreen()

    await waitFor(() => {
      expect(
        api.getHostSidebarWidth,
        'ProjectListScreen must pull the retained sidebar width on mount (replay) — the advertiser deduplicates and will never re-push it',
      ).toHaveBeenCalled()
    })
    await waitFor(() => expect(placeholderWidth(container)).toBe('240px'))
  })

  it('subscribes BEFORE pulling (no notify may slip between pull and subscribe)', async () => {
    const { unmount } = renderScreen()

    await waitFor(() => expect(api.getHostSidebarWidth).toHaveBeenCalled())

    const subscribeOrder = api.onHostSidebarWidthChanged.mock.invocationCallOrder[0]
    const pullOrder = api.getHostSidebarWidth.mock.invocationCallOrder[0]
    expect(subscribeOrder, 'mount must subscribe onHostSidebarWidthChanged').toBeDefined()
    expect(pullOrder, 'mount must pull getHostSidebarWidth').toBeDefined()
    expect(
      subscribeOrder!,
      'the subscription must be registered before the pull is issued',
    ).toBeLessThan(pullOrder!)

    unmount()
  })

  it('a push that lands while the pull is in flight wins over the stale pull result', async () => {
    let resolvePull: ((width: number) => void) | undefined
    api.getHostSidebarWidth.mockImplementation(
      () => new Promise<number | undefined>((resolve) => { resolvePull = resolve }),
    )

    const { container } = renderScreen()

    await waitFor(() => expect(api.getHostSidebarWidth).toHaveBeenCalled())
    expect(resolvePull).toBeDefined()

    act(() => pushWidth(280))
    await waitFor(() => expect(placeholderWidth(container)).toBe('280px'))

    await act(async () => {
      resolvePull!(240)
      await Promise.resolve()
    })
    expect(placeholderWidth(container)).toBe('280px')
  })

  it('a pull that resolves undefined (swallowed ipc error) keeps the seeded default and pushes still work', async () => {
    api.getHostSidebarWidth.mockImplementation(() => Promise.resolve(undefined))

    const { container } = renderScreen()

    await waitFor(() => expect(api.getHostSidebarWidth).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })
    expect(placeholderWidth(container)).toBe(`${HOST_SIDEBAR_DEFAULT_WIDTH}px`)

    act(() => pushWidth(200))
    await waitFor(() => expect(placeholderWidth(container)).toBe('200px'))
  })
})
