/**
 * Contract tests for `<SimulatorApp>` — the simulator page's top-level
 * component driving soft reload (ready-then-swap).
 *
 * On mount it boots a mini-app session and renders its DeviceShell wrapped
 * in an element carrying `data-shell-role="current"`. On `'simulator:relaunch'`
 * ({url}) it spawns a SECOND session in the background: its DeviceShell mounts
 * hidden, wrapped in `data-shell-role="pending"`, while the current shell stays
 * untouched and visible. Only once the pending session's root page reports
 * `'simulator:dom-ready'` ({bridgeId}) matching the pending bridgeId does the
 * app commit the swap: pending becomes current, the old shell unmounts, and
 * the old session is disposed over the native-host bridge. A dom-ready for an
 * unrelated bridgeId is ignored. A relaunch that arrives while a pending
 * session is still booting discards that pending session (dispose + replace)
 * in favor of the newest one — latest wins. A pending session that never
 * reports dom-ready within `SOFT_RELOAD_TIMEOUT_MS` is disposed and dropped,
 * leaving current untouched. A spawn that rejects produces no pending session
 * and never crashes the app.
 */
import React from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SIMULATOR_EVENTS } from '../shared/bridge-channels'
import { buildSimulatorUrlFromSpec } from '../shared/simulator-route'
import { SimulatorApp, SOFT_RELOAD_TIMEOUT_MS } from './simulator-app'

vi.mock('./device-shell/device-shell', () => ({
  DeviceShell: ({ bridgeId }: { bridgeId: string }) => (
    <div data-mock-shell={bridgeId} />
  ),
}))

// ─── native-host bridge mock ─────────────────────────────────────────────────
//
// Mirrors the production preload bridge shape (window.__diminaNativeHost).
// Each `spawn()` call hands back an incrementing session (s1/b1, s2/b2, …) so
// tests can tell sessions apart. `fire()` lets a test push a simulator event
// exactly the way main does over `onSimulatorEvent`.

const RELAUNCH_CHANNEL = 'simulator:relaunch'
const DOM_READY_CHANNEL = SIMULATOR_EVENTS.DOM_READY

type Listener = (payload: unknown) => void

interface SpawnResultStub {
  appSessionId: string
  bridgeId: string
  pagePath: string
  serviceWcId: number
  resourceBaseUrl: string
  manifest: { pages: string[]; entryPagePath: string }
  rootWindowConfig: Record<string, unknown>
}

function installNativeHostMock() {
  const listeners = new Map<string, Set<Listener>>()
  const disposeCalls: string[] = []
  let spawnCount = 0
  let spawnImpl: () => Promise<SpawnResultStub> = async () => {
    spawnCount += 1
    const n = spawnCount
    return {
      appSessionId: `s${n}`,
      bridgeId: `b${n}`,
      pagePath: 'pages/index/index',
      serviceWcId: n,
      resourceBaseUrl: '',
      manifest: { pages: ['pages/index/index'], entryPagePath: 'pages/index/index' },
      rootWindowConfig: {},
    }
  }

  const host = {
    enabled: true,
    device: undefined,
    spawn: async () => spawnImpl(),
    dispose: (appSessionId: string) => { disposeCalls.push(appSessionId) },
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

  return {
    disposeCalls,
    setSpawnImpl(fn: () => Promise<SpawnResultStub>) { spawnImpl = fn },
    fire(channel: string, payload: unknown) {
      const set = listeners.get(channel)
      for (const fn of [...(set ?? [])]) fn(payload)
    },
  }
}

type NativeHostMock = ReturnType<typeof installNativeHostMock>

function buildRelaunchUrl(pagePath = 'pages/other/other'): string {
  return buildSimulatorUrlFromSpec({
    appId: 'testapp',
    page: { pagePath, query: {} },
    port: 7788,
  })
}

function setRoute(): void {
  window.history.replaceState(
    {},
    '',
    '/simulator.html?appId=testapp&entry=pages/index/index&page=pages/index/index',
  )
}

beforeEach(() => {
  setRoute()
  window.__diminaCustomApis = { list: async () => [], invoke: async () => undefined }
})

afterEach(() => {
  delete (window as { __diminaNativeHost?: unknown }).__diminaNativeHost
  delete (window as { __diminaCustomApis?: unknown }).__diminaCustomApis
  vi.useRealTimers()
})

// ─── boot + relaunch helpers (shared across b–g) ─────────────────────────────

async function bootAndGetContainer(): Promise<{ container: HTMLElement; nativeHost: NativeHostMock }> {
  const nativeHost = installNativeHostMock()
  const { container } = render(<SimulatorApp />)
  await waitFor(() => {
    expect(container.querySelector('[data-shell-role="current"]')).toBeTruthy()
  })
  return { container, nativeHost }
}

async function relaunchAndWaitPending(
  container: HTMLElement,
  nativeHost: NativeHostMock,
  pagePath?: string,
): Promise<void> {
  await act(async () => {
    nativeHost.fire(RELAUNCH_CHANNEL, { url: buildRelaunchUrl(pagePath) })
    await Promise.resolve()
    await Promise.resolve()
  })
  await waitFor(() => {
    expect(container.querySelector('[data-shell-role="pending"]')).toBeTruthy()
  })
}

function shellIdOf(el: Element | null): string | null {
  return el?.querySelector('[data-mock-shell]')?.getAttribute('data-mock-shell') ?? null
}

// ─── a. initial boot ──────────────────────────────────────────────────────────

describe('SimulatorApp — initial boot', () => {
  it('spawns a session and renders its DeviceShell wrapped as the current shell', async () => {
    const { container } = await bootAndGetContainer()
    expect(container.querySelectorAll('[data-shell-role]')).toHaveLength(1)
    expect(shellIdOf(container.querySelector('[data-shell-role="current"]'))).toBe('b1')
  })

  it('exposes SOFT_RELOAD_TIMEOUT_MS as 15000', () => {
    expect(SOFT_RELOAD_TIMEOUT_MS).toBe(15000)
  })
})

// ─── b. relaunch spawns a hidden pending shell ───────────────────────────────

describe('SimulatorApp — simulator:relaunch spawns a background pending session', () => {
  it('renders the new DeviceShell hidden as pending while current stays visible and undisposed', async () => {
    const { container, nativeHost } = await bootAndGetContainer()
    await relaunchAndWaitPending(container, nativeHost)

    const current = container.querySelector('[data-shell-role="current"]')
    const pending = container.querySelector('[data-shell-role="pending"]')
    expect(shellIdOf(current)).toBe('b1')
    expect(shellIdOf(pending)).toBe('b2')
    expect((pending as HTMLElement).style.visibility).toBe('hidden')
    expect((current as HTMLElement).style.visibility).not.toBe('hidden')
    expect(nativeHost.disposeCalls).toEqual([])
  })
})

// ─── c. dom-ready promotes pending → current ─────────────────────────────────

describe('SimulatorApp — matching simulator:dom-ready commits the swap', () => {
  it('promotes pending to current, unmounts the old shell, and disposes the old session', async () => {
    const { container, nativeHost } = await bootAndGetContainer()
    await relaunchAndWaitPending(container, nativeHost)

    await act(async () => {
      nativeHost.fire(DOM_READY_CHANNEL, { bridgeId: 'b2' })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(container.querySelectorAll('[data-shell-role]')).toHaveLength(1)
    })
    const current = container.querySelector('[data-shell-role="current"]')
    expect(shellIdOf(current)).toBe('b2')
    expect((current as HTMLElement).style.visibility).not.toBe('hidden')
    expect(container.querySelector('[data-shell-role="pending"]')).toBeNull()
    expect(nativeHost.disposeCalls).toEqual(['s1'])
  })
})

// ─── d. dom-ready with an unrelated bridgeId is ignored ──────────────────────

describe('SimulatorApp — unrelated simulator:dom-ready', () => {
  it('does not swap or dispose when the bridgeId does not match the pending session', async () => {
    const { container, nativeHost } = await bootAndGetContainer()
    await relaunchAndWaitPending(container, nativeHost)

    await act(async () => {
      nativeHost.fire(DOM_READY_CHANNEL, { bridgeId: 'unrelated-bridge' })
      await Promise.resolve()
    })

    expect(shellIdOf(container.querySelector('[data-shell-role="current"]'))).toBe('b1')
    expect(shellIdOf(container.querySelector('[data-shell-role="pending"]'))).toBe('b2')
    expect(nativeHost.disposeCalls).toEqual([])
  })
})

// ─── e. relaunch-before-ready discards the stale pending (latest wins) ───────

describe('SimulatorApp — relaunch arrives again before the pending session is ready', () => {
  it('disposes the stale pending session and replaces it with a third (latest wins)', async () => {
    const { container, nativeHost } = await bootAndGetContainer()
    await relaunchAndWaitPending(container, nativeHost, 'pages/other/other')
    expect(shellIdOf(container.querySelector('[data-shell-role="pending"]'))).toBe('b2')

    await relaunchAndWaitPending(container, nativeHost, 'pages/third/third')

    expect(nativeHost.disposeCalls).toEqual(['s2'])
    expect(shellIdOf(container.querySelector('[data-shell-role="current"]'))).toBe('b1')
    expect(shellIdOf(container.querySelector('[data-shell-role="pending"]'))).toBe('b3')
  })
})

// ─── f. pending timeout ───────────────────────────────────────────────────────

describe('SimulatorApp — pending session never reports dom-ready', () => {
  it('disposes and drops the pending session after SOFT_RELOAD_TIMEOUT_MS, current stays put', async () => {
    vi.useFakeTimers()
    const nativeHost = installNativeHostMock()
    const { container } = render(<SimulatorApp />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(shellIdOf(container.querySelector('[data-shell-role="current"]'))).toBe('b1')

    await act(async () => {
      nativeHost.fire(RELAUNCH_CHANNEL, { url: buildRelaunchUrl() })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(shellIdOf(container.querySelector('[data-shell-role="pending"]'))).toBe('b2')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SOFT_RELOAD_TIMEOUT_MS)
    })

    expect(container.querySelector('[data-shell-role="pending"]')).toBeNull()
    expect(shellIdOf(container.querySelector('[data-shell-role="current"]'))).toBe('b1')
    expect(nativeHost.disposeCalls).toEqual(['s2'])
  })
})

// ─── relaunch racing a just-committed promote ────────────────────────────────

describe('SimulatorApp — RELAUNCH immediately after a promote', () => {
  it('does not dispose the just-promoted current session', async () => {
    const { container, nativeHost } = await bootAndGetContainer()
    await relaunchAndWaitPending(container, nativeHost)

    // Fire dom-ready and the next relaunch back-to-back WITHOUT an act()
    // flush between them — bridge events arrive outside React batching, so a
    // slot mirror synced by a passive effect still names the just-promoted
    // session "pending" here and would dispose the live shell (s2) out from
    // under the user. The authoritative ref must be updated synchronously in
    // the promote itself.
    nativeHost.fire(DOM_READY_CHANNEL, { bridgeId: 'b2' })
    nativeHost.fire(RELAUNCH_CHANNEL, { url: buildRelaunchUrl('pages/third/third') })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Only the promote's dispose of the ORIGINAL session may have happened;
    // the promoted session (s2) stays alive as current while the follow-up
    // relaunch boots s3 as the new pending.
    expect(nativeHost.disposeCalls).toEqual(['s1'])
    await waitFor(() => {
      expect(shellIdOf(container.querySelector('[data-shell-role="current"]'))).toBe('b2')
      expect(shellIdOf(container.querySelector('[data-shell-role="pending"]'))).toBe('b3')
    })
  })
})

// ─── g. spawn rejection ───────────────────────────────────────────────────────

describe('SimulatorApp — relaunch spawn rejects', () => {
  it('produces no pending session, keeps current, and does not crash', async () => {
    const { container, nativeHost } = await bootAndGetContainer()
    nativeHost.setSpawnImpl(async () => {
      throw new Error('spawn failed')
    })

    await act(async () => {
      nativeHost.fire(RELAUNCH_CHANNEL, { url: buildRelaunchUrl() })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-shell-role="pending"]')).toBeNull()
    expect(shellIdOf(container.querySelector('[data-shell-role="current"]'))).toBe('b1')
    expect(screen.queryByText(/error/i)).toBeNull()
  })
})
