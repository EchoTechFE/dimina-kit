/**
 * Resurrects the PR #12 `use-session-hot-reload` guard that PR #39
 * (a85fb6dc, "Worktree workbench landing") deleted together with the dead
 * `<webview>` reload branch — without replacing it with a native-host
 * equivalent. Regression: editor save → dmcc rebuild → `projectStatus`
 * arrives with `hotReload: true` → renderer drops the flag on the floor →
 * the simulator never refreshes.
 *
 * Contract under test (TDD — NOT yet implemented):
 *  - `useSession`'s result gains a numeric `hotReloadToken`.
 *  - Every `projectStatus` payload with `hotReload === true` bumps the token
 *    (strictly increasing number). The token is the renderer-side signal that
 *    `use-simulator.ts` folds into its native attach-effect deps to trigger a
 *    DeviceShell teardown + respawn (`attachNativeSimulator`).
 *  - Payloads WITHOUT `hotReload` (or with `hotReload: false`) must NOT move
 *    the token — compile-status chatter (compiling → ready → error → ready)
 *    must never cause a spurious simulator reload.
 *
 * Today `onProjectStatus`'s handler only calls `setCompileStatus(data)`
 * (use-session.ts:96-100), so every assertion on `hotReloadToken` fails —
 * that is the intended red state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { SessionHookResult } from './use-session'

// ── Module mocks ─────────────────────────────────────────────────────────
//
// `use-session.ts` imports typed IPC helpers from `@/shared/api`. Mock the
// module so the hook runs without a preload bridge, and capture the
// projectStatus listener so the test can play "main process sends a payload".

// vi.mock factories are hoisted above module-level consts, so the shared
// listener registry must be created via vi.hoisted to avoid a TDZ crash.
const { projectStatusListeners } = vi.hoisted(() => ({
  projectStatusListeners: [] as Array<(s: unknown) => void>,
}))

function emitProjectStatus(payload: {
  status: string
  message: string
  hotReload?: boolean
}): void {
  for (const fn of [...projectStatusListeners]) fn(payload)
}

vi.mock('@/shared/api', () => {
  return {
    openProject: vi.fn(async () => ({
      success: true,
      appInfo: { appId: 'fake-app' },
      port: 12345,
    })),
    getProjectPages: vi.fn(async () => ({
      pages: ['pages/index/index'],
      entryPagePath: 'pages/index/index',
    })),
    getCompileConfig: vi.fn(async () => ({
      startPage: 'pages/index/index',
      scene: 1011,
      queryParams: [],
    })),
    saveCompileConfig: vi.fn(async () => {}),
    onProjectStatus: vi.fn((handler: (s: unknown) => void) => {
      projectStatusListeners.push(handler)
      return () => {
        const i = projectStatusListeners.indexOf(handler)
        if (i >= 0) projectStatusListeners.splice(i, 1)
      }
    }),
  }
})

// Import AFTER the mock declaration (vitest hoists vi.mock anyway, but keep
// the reading order honest).
import { useSession } from './use-session'

beforeEach(() => {
  projectStatusListeners.length = 0
})

/**
 * Read the (future) `hotReloadToken` off the session result. Typed as a
 * structural lookup so this test file compiles before the implementation
 * lands; the runtime assertion is what goes red.
 */
function readToken(session: SessionHookResult): number {
  const token = (session as unknown as { hotReloadToken?: unknown }).hotReloadToken
  expect(
    typeof token,
    'useSession must expose a numeric hotReloadToken (resurrect the PR#12 hot-reload guard deleted in PR#39)',
  ).toBe('number')
  return token as number
}

async function renderReadySession() {
  const rendered = renderHook(() => useSession({ projectPath: '/tmp/fake-project' }))
  // Wait for the async openProject → ready flow so later status emissions
  // are unambiguously watcher-driven, not initial-load races.
  await waitFor(() => {
    expect(rendered.result.current.compileStatus.status).toBe('ready')
  })
  return rendered
}

describe('useSession: hotReload signal → hotReloadToken (resurrected PR#12 guard, deleted in PR#39)', () => {
  it('exposes hotReloadToken as a number from the first ready render', async () => {
    const { result } = await renderReadySession()
    readToken(result.current)
  })

  it('bumps hotReloadToken when projectStatus arrives with hotReload:true', async () => {
    const { result } = await renderReadySession()
    const before = readToken(result.current)

    act(() => {
      emitProjectStatus({ status: 'ready', message: '编译完成，已热更新', hotReload: true })
    })

    const after = readToken(result.current)
    expect(
      after,
      'a watcher-rebuild notification (hotReload:true) must strictly increase hotReloadToken',
    ).toBeGreaterThan(before)
    // The status payload itself must still reach compileStatus unchanged.
    expect(result.current.compileStatus.message).toBe('编译完成，已热更新')
  })

  it('bumps the token once per hotReload:true notification (strictly increasing across N rebuilds)', async () => {
    const { result } = await renderReadySession()
    const t0 = readToken(result.current)

    act(() => {
      emitProjectStatus({ status: 'ready', message: '编译完成，已热更新', hotReload: true })
    })
    const t1 = readToken(result.current)

    act(() => {
      emitProjectStatus({ status: 'ready', message: '编译完成，已热更新', hotReload: true })
    })
    const t2 = readToken(result.current)

    act(() => {
      emitProjectStatus({ status: 'ready', message: '编译完成，已热更新', hotReload: true })
    })
    const t3 = readToken(result.current)

    // Each rebuild notification is one reload trigger: every emission must
    // move the token (3 emissions → 3 distinct, increasing values).
    expect(t1).toBeGreaterThan(t0)
    expect(t2).toBeGreaterThan(t1)
    expect(t3).toBeGreaterThan(t2)
  })

  it('does NOT bump the token on status payloads without hotReload (status chatter must not reload the simulator)', async () => {
    const { result } = await renderReadySession()
    const before = readToken(result.current)

    // Typical non-watcher status traffic: relaunch progress, recompiles,
    // error → recovery. None of these carry hotReload.
    act(() => {
      emitProjectStatus({ status: 'compiling', message: '正在编译...' })
    })
    act(() => {
      emitProjectStatus({ status: 'error', message: '编译失败' })
    })
    act(() => {
      emitProjectStatus({ status: 'ready', message: '编译完成' })
    })

    expect(
      readToken(result.current),
      'plain status updates must never trigger a simulator reload',
    ).toBe(before)
    // Status itself still flows through.
    expect(result.current.compileStatus.message).toBe('编译完成')
  })

  it('does NOT bump the token on an explicit hotReload:false payload', async () => {
    const { result } = await renderReadySession()
    const before = readToken(result.current)

    act(() => {
      emitProjectStatus({ status: 'ready', message: '编译完成', hotReload: false })
    })

    expect(readToken(result.current)).toBe(before)
  })
})
