/**
 * Contract: `<SimulatorApp>` must render a VISIBLE error state when the
 * initial boot cannot produce a shell — today both failure modes below are
 * silent (nothing renders but a bare Suspense fallback of `null`), which
 * reads to the user as a plain white/blank device.
 *
 * Failure modes covered:
 *  1. `window.location.search` has no parseable route (missing appId/entry)
 *     — `parseLocationRoute` returns null and the boot effect just
 *     `return`s (simulator-app.tsx: `if (!route) return`).
 *  2. The route parses, but `bootShellSession` (spawn over
 *     `window.__diminaNativeHost.spawn`) rejects — the effect currently only
 *     `console.error`s (simulator-app.tsx: `catch (err) { console.error(...) }`)
 *     and never touches component state, so nothing changes on screen.
 *
 * The fix under test must add an error slot the app renders in either case:
 * `[data-testid="sim-boot-error"]` containing readable text — the thrown
 * error's message for the spawn-rejection case, and a readable "missing boot
 * params" hint for the unparseable-route case. The success path (spawn
 * resolves, route parses) must NOT render this node — a regression that
 * always shows the error slot would be just as bad as never showing it.
 */
import React from 'react'
import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimulatorApp } from './simulator-app'

vi.mock('./device-shell/device-shell', () => ({
  DeviceShell: ({ bridgeId }: { bridgeId: string }) => (
    <div data-mock-shell={bridgeId} />
  ),
}))

type Listener = (payload: unknown) => void

function installNativeHostMock(spawnImpl: () => Promise<unknown>) {
  const listeners = new Map<string, Set<Listener>>()
  const host = {
    enabled: true,
    device: undefined,
    spawn: async () => spawnImpl(),
    dispose: () => {},
    openPage: async () => ({ bridgeId: 'unused', pagePath: 'unused', windowConfig: {}, isTab: false }),
    closePage: () => {},
    notifyLifecycle: () => {},
    notifyNavCallback: () => {},
    notifyApiResponse: () => {},
    notifyActivePage: () => {},
    notifyPageStack: () => {},
    createRenderHostUrl: () => 'about:blank',
    renderPreloadUrl: 'about:blank',
    onSimulatorEvent: (channel: string, listener: Listener) => {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      set.add(listener)
      return () => { set!.delete(listener) }
    },
  }
  window.__diminaNativeHost = host as unknown as Window['__diminaNativeHost']
}

function setValidRoute(): void {
  window.history.replaceState(
    {},
    '',
    '/simulator.html?appId=testapp&entry=pages/index/index&page=pages/index/index',
  )
}

function setInvalidRoute(): void {
  // No appId, no entry — parseLocationRoute must return null for this.
  window.history.replaceState({}, '', '/simulator.html?foo=bar')
}

function resolvedSpawnStub() {
  return async () => ({
    appSessionId: 's1',
    bridgeId: 'b1',
    pagePath: 'pages/index/index',
    serviceWcId: 1,
    resourceBaseUrl: '',
    manifest: { pages: ['pages/index/index'], entryPagePath: 'pages/index/index' },
    rootWindowConfig: {},
  })
}

beforeEach(() => {
  window.__diminaCustomApis = { list: async () => [], invoke: async () => undefined }
})

afterEach(() => {
  delete (window as { __diminaNativeHost?: unknown }).__diminaNativeHost
  delete (window as { __diminaCustomApis?: unknown }).__diminaCustomApis
})

describe('SimulatorApp — initial boot failure must render a visible error state', () => {
  it('renders [data-testid="sim-boot-error"] with the error message when spawn rejects', async () => {
    setValidRoute()
    installNativeHostMock(async () => {
      throw new Error('native-host spawn exploded')
    })

    const { container } = render(<SimulatorApp />)

    await waitFor(() => {
      expect(container.querySelector('[data-testid="sim-boot-error"]')).toBeTruthy()
    })
    const errorNode = container.querySelector('[data-testid="sim-boot-error"]')
    expect(errorNode?.textContent).toContain('native-host spawn exploded')
  })

  it('renders [data-testid="sim-boot-error"] with a readable hint when the URL has no parseable route', async () => {
    setInvalidRoute()
    installNativeHostMock(resolvedSpawnStub())

    const { container } = render(<SimulatorApp />)

    await waitFor(() => {
      expect(container.querySelector('[data-testid="sim-boot-error"]')).toBeTruthy()
    })
    const errorNode = container.querySelector('[data-testid="sim-boot-error"]')
    expect(errorNode?.textContent?.length ?? 0).toBeGreaterThan(0)
  })

  it('does NOT render the error slot when boot succeeds (success path stays regression-free)', async () => {
    setValidRoute()
    installNativeHostMock(resolvedSpawnStub())

    const { container } = render(<SimulatorApp />)

    await waitFor(() => {
      expect(container.querySelector('[data-shell-role="current"]')).toBeTruthy()
    })
    expect(container.querySelector('[data-testid="sim-boot-error"]')).toBeNull()
  })
})
