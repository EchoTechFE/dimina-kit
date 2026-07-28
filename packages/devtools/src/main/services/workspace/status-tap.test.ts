/**
 * Notifier tap — the ONE bookkeeping site where the two compile-state pushes
 * (`projectStatus` / `compileLog`) land in the main-process authorities
 * (session-status store + compile-log buffer) before the renderer broadcast.
 *
 * Contracts pinned here:
 *  - both payloads are recorded BEFORE the wrapped notifier forwards them
 *  - a fresh open ('compiling' without hotReload) clears the log buffer
 *    (new compile timeline); hot-reload 'ready' chatter keeps appending
 *  - every other notifier method passes through untouched
 */
import { describe, it, expect, vi } from 'vitest'
import type { RendererNotifier } from '../notifications/renderer-notifier.js'
import { createCompileLogBuffer } from './compile-log-buffer.js'
import { createSessionStatusStore } from './session-status-store.js'
import { tapNotifierIntoStores } from './status-tap.js'

function makeFixture() {
  const inner = {
    projectStatus: vi.fn(),
    compileLog: vi.fn(),
    windowNavigateBack: vi.fn(),
  } as unknown as RendererNotifier
  const status = createSessionStatusStore()
  const compileLogs = createCompileLogBuffer()
  const tapped = tapNotifierIntoStores(inner, status, compileLogs)
  return { inner, status, compileLogs, tapped }
}

describe('tapNotifierIntoStores', () => {
  it('records projectStatus into the store then forwards the same payload', () => {
    const { inner, status, tapped } = makeFixture()

    tapped.projectStatus({ status: 'compiling', message: '编译中' })
    expect(status.get()).toMatchObject({ phase: 'compiling', message: '编译中', generation: 1 })
    expect(inner.projectStatus).toHaveBeenCalledWith({ status: 'compiling', message: '编译中' })

    tapped.projectStatus({ status: 'ready', message: '编译完成' })
    expect(status.get()).toMatchObject({ phase: 'ready', generation: 2 })
  })

  it('the store is recorded before the renderer forward (store is the authority)', () => {
    const { inner, status, tapped } = makeFixture()
    let phaseAtForwardTime = ''
    vi.mocked(inner.projectStatus).mockImplementation(() => {
      phaseAtForwardTime = status.get().phase
    })
    tapped.projectStatus({ status: 'error', message: 'boom' })
    expect(phaseAtForwardTime).toBe('error')
  })

  it('appends compileLog lines to the buffer and forwards them', () => {
    const { inner, compileLogs, tapped } = makeFixture()
    tapped.compileLog({ at: 1, stream: 'stderr', text: 'oops' })
    expect(compileLogs.read({}).entries).toMatchObject([{ seq: 1, stream: 'stderr', text: 'oops' }])
    expect(inner.compileLog).toHaveBeenCalledWith({ at: 1, stream: 'stderr', text: 'oops' })
  })

  it("a fresh open ('compiling', no hotReload) clears the buffer; hot-reload chatter does not", () => {
    const { compileLogs, tapped } = makeFixture()
    tapped.compileLog({ at: 1, stream: 'stdout', text: 'first compile' })

    // Hot-reload status transitions never reset the timeline.
    tapped.projectStatus({ status: 'ready', message: 'rebuilt', hotReload: true })
    expect(compileLogs.read({}).entries).toHaveLength(1)

    // A NEW open starts a new compile timeline.
    tapped.projectStatus({ status: 'compiling', message: '' })
    expect(compileLogs.read({}).entries).toHaveLength(0)

    tapped.compileLog({ at: 2, stream: 'stdout', text: 'second compile' })
    // seq survives the clear — cursor continuity across opens.
    expect(compileLogs.read({}).entries).toMatchObject([{ seq: 2, text: 'second compile' }])
  })

  it('passes non-compile methods through to the wrapped notifier untouched', () => {
    const { inner, tapped } = makeFixture()
    tapped.windowNavigateBack()
    expect(inner.windowNavigateBack).toHaveBeenCalledTimes(1)
  })
})
