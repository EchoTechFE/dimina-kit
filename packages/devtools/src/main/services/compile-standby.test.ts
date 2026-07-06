/**
 * Contract for the devtools-side warm-standby glue
 * (`setupCompileWorkerStandby` in `src/main/services/compile-standby.ts`):
 * the one place devtools turns on devkit's compile-worker warm standby and
 * wires its lifecycle events into the diagnostics bus.
 *
 * The standby is a pure accelerator, so this glue must be structurally
 * incapable of breaking startup: devkit is loaded ASYNCHRONOUSLY (injectable
 * via `deps.loadDevkit` — these tests never fork anything real), a missing /
 * broken devkit degrades silently, and dispose() is safe at any moment —
 * including before the devkit import has even resolved (the teardown race).
 *
 * Event → diagnostics severity mapping (code is always 'compile-standby'):
 *   spawned / prewarmed / adopted        → info
 *   died / health-check-failed           → warn
 *   degraded                             → error
 * The message names the event type and carries pid/reason when present.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DiagnosticsBus } from './diagnostics/index.js'

type StandbyEventLike = { type: string; pid?: number; reason?: string }
type EnableOpts = { onEvent?: (ev: StandbyEventLike) => void }
type FakeManager = { state: string; dispose: ReturnType<typeof vi.fn> }
type SetupFn = (
  ctx: { diagnostics?: DiagnosticsBus },
  deps?: { loadDevkit?: () => Promise<unknown> },
) => { dispose: () => Promise<void> }

async function getSetup(): Promise<SetupFn> {
  const mod: unknown = await import('./compile-standby.js' as string).catch(() => null)
  expect(
    mod,
    'src/main/services/compile-standby must exist — the devtools glue that enables the compile-worker warm standby',
  ).not.toBeNull()
  const fn = (mod as Record<string, unknown>).setupCompileWorkerStandby
  expect(
    typeof fn,
    'compile-standby must export setupCompileWorkerStandby(ctx, deps?)',
  ).toBe('function')
  return fn as SetupFn
}

/** A scripted stand-in for the dynamically imported devkit module. */
function makeFakeDevkit(): {
  module: Record<string, unknown>
  enable: ReturnType<typeof vi.fn>
  manager: FakeManager
  emit: (ev: StandbyEventLike) => void
} {
  const manager: FakeManager = { state: 'ready', dispose: vi.fn(async () => {}) }
  let capturedOnEvent: ((ev: StandbyEventLike) => void) | null = null
  const enable = vi.fn((opts?: EnableOpts) => {
    capturedOnEvent = opts?.onEvent ?? null
    return manager
  })
  return {
    module: { enableCompileWorkerStandby: enable },
    enable,
    manager,
    emit: (ev) => {
      capturedOnEvent?.(ev)
    },
  }
}

type ReportArg = { severity: string; code: string; message: string }

/** Minimal DiagnosticsBus double — report is the only method under test. */
function makeFakeDiagnostics(): { bus: DiagnosticsBus; reports: ReportArg[] } {
  const reports: ReportArg[] = []
  const bus = {
    report: (d: ReportArg) => {
      reports.push(d)
    },
    subscribe: () => ({ dispose: () => {} }),
    dispose: () => {},
  } as DiagnosticsBus
  return { bus, reports }
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('setupCompileWorkerStandby — enabling', () => {
  it('loads devkit asynchronously and calls enableCompileWorkerStandby exactly once, with an onEvent hook', async () => {
    const setup = await getSetup()
    const devkit = makeFakeDevkit()
    const { bus } = makeFakeDiagnostics()

    const handle = setup({ diagnostics: bus }, { loadDevkit: async () => devkit.module })

    await vi.waitFor(() => {
      expect(devkit.enable).toHaveBeenCalledTimes(1)
    })
    const opts = devkit.enable.mock.calls[0]?.[0] as EnableOpts | undefined
    expect(
      typeof opts?.onEvent,
      'the glue must pass an onEvent hook — without it standby lifecycle events are invisible to diagnostics',
    ).toBe('function')

    await handle.dispose()
  })
})

describe('setupCompileWorkerStandby — event → diagnostics mapping', () => {
  it('maps spawned/prewarmed/adopted to info, died/health-check-failed to warn, degraded to error — all with code compile-standby and the event type in the message', async () => {
    const setup = await getSetup()
    const devkit = makeFakeDevkit()
    const { bus, reports } = makeFakeDiagnostics()
    const handle = setup({ diagnostics: bus }, { loadDevkit: async () => devkit.module })
    await vi.waitFor(() => {
      expect(devkit.enable).toHaveBeenCalledTimes(1)
    })

    devkit.emit({ type: 'spawned', pid: 4242 })
    devkit.emit({ type: 'prewarmed', pid: 4242 })
    devkit.emit({ type: 'adopted', pid: 4242 })
    devkit.emit({ type: 'died', pid: 4242, reason: 'exit code 1' })
    devkit.emit({ type: 'health-check-failed', reason: 'ping timeout' })
    devkit.emit({ type: 'degraded', reason: '3 deaths in 30000ms' })

    expect(reports).toHaveLength(6)
    for (const report of reports) {
      expect(report.code, 'every standby diagnostic carries the one stable code').toBe('compile-standby')
    }
    expect(reports.map((r) => r.severity)).toEqual(['info', 'info', 'info', 'warn', 'warn', 'error'])
    expect(reports[0]!.message).toContain('spawned')
    expect(reports[1]!.message).toContain('prewarmed')
    expect(reports[2]!.message).toContain('adopted')
    expect(reports[3]!.message).toContain('died')
    expect(reports[4]!.message).toContain('health-check-failed')
    expect(reports[5]!.message).toContain('degraded')

    await handle.dispose()
  })

  it('includes pid and reason in the message when the event carries them', async () => {
    const setup = await getSetup()
    const devkit = makeFakeDevkit()
    const { bus, reports } = makeFakeDiagnostics()
    const handle = setup({ diagnostics: bus }, { loadDevkit: async () => devkit.module })
    await vi.waitFor(() => {
      expect(devkit.enable).toHaveBeenCalledTimes(1)
    })

    devkit.emit({ type: 'spawned', pid: 31337 })
    devkit.emit({ type: 'degraded', reason: 'crash-looping entry' })

    expect(reports[0]!.message, 'a pid on the event must be visible in the diagnostic').toContain('31337')
    expect(reports[1]!.message, 'a reason on the event must be visible in the diagnostic').toContain('crash-looping entry')

    await handle.dispose()
  })

  it('a missing ctx.diagnostics never throws — events are simply not reported anywhere', async () => {
    const setup = await getSetup()
    const devkit = makeFakeDevkit()
    const handle = setup({}, { loadDevkit: async () => devkit.module })
    await vi.waitFor(() => {
      expect(devkit.enable).toHaveBeenCalledTimes(1)
    })

    expect(() => {
      devkit.emit({ type: 'spawned', pid: 1 })
      devkit.emit({ type: 'degraded', reason: 'x' })
    }).not.toThrow()

    await handle.dispose()
  })
})

describe('setupCompileWorkerStandby — dispose', () => {
  it('dispose() passes through to manager.dispose(), and a second dispose() does not call it again', async () => {
    const setup = await getSetup()
    const devkit = makeFakeDevkit()
    const { bus } = makeFakeDiagnostics()
    const handle = setup({ diagnostics: bus }, { loadDevkit: async () => devkit.module })
    await vi.waitFor(() => {
      expect(devkit.enable).toHaveBeenCalledTimes(1)
    })

    await handle.dispose()
    expect(
      devkit.manager.dispose,
      'the glue owns the manager it enabled — its dispose() must tear the standby down',
    ).toHaveBeenCalledTimes(1)

    await handle.dispose()
    expect(
      devkit.manager.dispose,
      'dispose() is idempotent — a double teardown must not double-dispose the manager',
    ).toHaveBeenCalledTimes(1)
  })

  it('dispose() BEFORE the devkit import resolves leaves no live manager behind (teardown race immunity)', async () => {
    const setup = await getSetup()
    const devkit = makeFakeDevkit()
    const { bus } = makeFakeDiagnostics()

    let resolveLoad: (mod: unknown) => void = () => {}
    const gate = new Promise<unknown>((resolve) => {
      resolveLoad = resolve
    })
    const handle = setup({ diagnostics: bus }, { loadDevkit: () => gate })

    // Teardown wins the race: the app is closing while devkit is still loading.
    await handle.dispose()

    // devkit resolves late — whatever the glue does now, it must not leave a
    // live manager running unowned. Either it skips enabling entirely, or it
    // enables and immediately disposes what it created.
    resolveLoad(devkit.module)
    await flushAsync()
    await flushAsync()

    if (devkit.enable.mock.calls.length > 0) {
      expect(
        devkit.manager.dispose,
        'a manager created AFTER dispose() already ran must be disposed immediately — a late devkit resolve must not resurrect the standby',
      ).toHaveBeenCalled()
    }
    else {
      expect(devkit.enable, 'never enabling after dispose is equally correct').not.toHaveBeenCalled()
    }
  })
})

describe('setupCompileWorkerStandby — devkit unavailable degrades silently', () => {
  it('a rejecting loadDevkit neither throws nor reports an error-severity diagnostic, and dispose() still resolves', async () => {
    const setup = await getSetup()
    const { bus, reports } = makeFakeDiagnostics()

    const handle = setup(
      { diagnostics: bus },
      { loadDevkit: () => Promise.reject(new Error('devkit not installed')) },
    )
    await flushAsync()
    await flushAsync()

    expect(
      reports.filter((r) => r.severity === 'error'),
      'a missing accelerator is not an error — error-severity noise here would train users to ignore the diagnostics panel',
    ).toHaveLength(0)
    await expect(handle.dispose()).resolves.toBeUndefined()
  })

  it('a devkit module WITHOUT enableCompileWorkerStandby neither throws nor reports an error, and dispose() still resolves', async () => {
    const setup = await getSetup()
    const { bus, reports } = makeFakeDiagnostics()

    const handle = setup(
      { diagnostics: bus },
      { loadDevkit: async () => ({ openProject: () => {} }) },
    )
    await flushAsync()
    await flushAsync()

    expect(reports.filter((r) => r.severity === 'error')).toHaveLength(0)
    await expect(handle.dispose()).resolves.toBeUndefined()
  })
})
