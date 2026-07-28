/**
 * MCP-pushed project open — renderer api wrapper.
 *
 * CONTRACT (public API on view-api.ts):
 *
 *   export function onWindowOpenProject(
 *     handler: (project: { name: string; path: string }) => void,
 *   ): () => void
 *
 * It must subscribe on the 'window:openProject' wire channel (the push the
 * main-side MCP `project_open` sends via `notify.windowOpenProject`) and hand
 * the project payload to the handler. Without this subscription the MCP open
 * push lands nowhere: the renderer owns the open path (mounting
 * ProjectRuntime is what compiles and attaches the simulator), so
 * `project_open` would hang until its settle timeout.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const transport = vi.hoisted(() => ({
  invoke: vi.fn((_channel: string, ..._args: unknown[]) => Promise.resolve<unknown>(undefined)),
  invokeStrict: vi.fn((_channel: string, ..._args: unknown[]) => Promise.resolve<unknown>(undefined)),
  send: vi.fn(),
  sendSync: vi.fn(),
  on: vi.fn((_channel: string, _handler: (...args: unknown[]) => void) => () => {}),
}))

vi.mock('./ipc-transport', () => transport)

import { onWindowOpenProject } from './view-api'

// Wire name asserted literally on purpose: a wrapper drifting to any other
// name silently disconnects the MCP project_open push.
const OPEN_PROJECT_CHANNEL = 'window:openProject'

beforeEach(() => {
  transport.on.mockClear()
})

describe('view-api: onWindowOpenProject wrapper', () => {
  it('subscribes on window:openProject and forwards the project payload', () => {
    const received: unknown[] = []
    onWindowOpenProject((p) => received.push(p))

    const call = transport.on.mock.calls.find(([channel]) => channel === OPEN_PROJECT_CHANNEL)
    expect(call, 'expected a subscription on window:openProject').toBeDefined()

    const wireHandler = call![1] as (...args: unknown[]) => void
    wireHandler({ name: 'demo', path: '/proj/demo' })
    expect(received).toEqual([{ name: 'demo', path: '/proj/demo' }])
  })

  it('returns the transport unsubscribe function', () => {
    const off = vi.fn()
    transport.on.mockReturnValueOnce(off)
    const returned = onWindowOpenProject(() => {})
    expect(returned).toBe(off)
  })
})
