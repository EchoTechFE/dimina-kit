/**
 * ROUND 2 (dmcc 日志链路) — renderer API seam contract (TDD, NOT yet
 * implemented).
 *
 * Pinned contract: `project-api.ts` exports
 * `onCompileLog(handler: (entry) => void): () => void` — the main→renderer
 * subscription for `ProjectChannel.CompileLog` ('project:compileLog'),
 * exactly mirroring `onProjectStatus`. Entry shape:
 * `{ at: number; stream: 'stdout' | 'stderr'; text: string }` (the payload
 * `RendererNotifier.compileLog` sends).
 *
 * The ipc-transport module is mocked at its seam so this suite asserts only
 * the channel wiring, not the preload bridge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const transportSeam = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  return {
    listeners,
    unsubscribe: vi.fn(),
    emit(channel: string, ...args: unknown[]) {
      for (const listener of listeners.get(channel) ?? []) listener(...args)
    },
    reset() {
      listeners.clear()
      transportSeam.unsubscribe.mockClear()
    },
  }
})

vi.mock('./ipc-transport', () => ({
  invoke: vi.fn(async () => null),
  invokeStrict: vi.fn(async () => null),
  on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    const existing = transportSeam.listeners.get(channel) ?? []
    existing.push(listener)
    transportSeam.listeners.set(channel, existing)
    return transportSeam.unsubscribe
  }),
}))

import * as projectApi from './project-api'

interface CompileLogEntry {
  at: number
  stream: 'stdout' | 'stderr'
  text: string
}

type OnCompileLog = (handler: (entry: CompileLogEntry) => void) => () => void

function getOnCompileLog(): OnCompileLog {
  const fn = (projectApi as Record<string, unknown>).onCompileLog
  expect(
    typeof fn,
    "project-api must export onCompileLog(handler) — the renderer subscription for the 'project:compileLog' push (mirrors onProjectStatus)",
  ).toBe('function')
  return fn as OnCompileLog
}

beforeEach(() => {
  transportSeam.reset()
})

describe('onCompileLog (renderer API seam)', () => {
  it("subscribes on the 'project:compileLog' wire channel", () => {
    const onCompileLog = getOnCompileLog()
    onCompileLog(() => {})

    expect(
      transportSeam.listeners.has('project:compileLog'),
      "onCompileLog must register its transport listener on 'project:compileLog'",
    ).toBe(true)
  })

  it('delivers the pushed payload to the handler', () => {
    const onCompileLog = getOnCompileLog()
    const handler = vi.fn()
    onCompileLog(handler)

    const payload: CompileLogEntry = {
      at: 1765500000000,
      stream: 'stderr',
      text: '✖ 编译页面逻辑 [FAILED: Transform failed with 1 error:',
    }
    transportSeam.emit('project:compileLog', payload)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(payload)
  })

  it('returns the transport unsubscribe function', () => {
    const onCompileLog = getOnCompileLog()
    const off = onCompileLog(() => {})
    expect(typeof off).toBe('function')
    off()
    expect(transportSeam.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
