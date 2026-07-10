/**
 * Guards ProjectFsClient's write-RPC timeout semantics: a timed-out write op
 * (which always carries an idempotent opId) is re-sent EXACTLY once with the
 * same opId — the retry's own timer rejects terminally instead of re-entering
 * the retry branch — and a plain read RPC (no opId) rejects on first timeout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectFsClient } from './client.js'

type Internals = Omit<ProjectFsClient, 'core'> & {
  pending: Map<number, unknown>
  seq: number
  // Narrow structural stand-in for the real `Worker` — `_rpc` only posts.
  core: { postMessage: (msg: unknown) => void }
  _rpc<T>(op: string, args: Record<string, unknown>, opts?: { opId?: string; timeout?: number }): Promise<T>
}

function makeRpcClient(): { client: Internals; posted: Array<{ id: number; op: string; opId?: string }> } {
  const posted: Array<{ id: number; op: string; opId?: string }> = []
  const c = new ProjectFsClient() as unknown as Internals
  c.pending = new Map()
  c.seq = 0
  c.core = { postMessage: (msg) => posted.push(msg as { id: number; op: string; opId?: string }) }
  return { client: c, posted }
}

describe('ProjectFsClient — write-RPC timeout retry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-sends once with the SAME opId, then rejects terminally on the retry timeout', async () => {
    vi.useFakeTimers()
    const { client, posted } = makeRpcClient()
    const p = client._rpc('write', { path: 'a.txt' }, { opId: 'op-1', timeout: 1000 })
    const rejected = expect(p).rejects.toThrow('write timeout (after retry)')
    expect(posted).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1000) // first timeout → one retry
    expect(posted).toHaveLength(2)
    expect(posted[1]!.opId).toBe('op-1')
    expect(posted[1]!.id).not.toBe(posted[0]!.id)

    await vi.advanceTimersByTimeAsync(1000) // retry timeout → terminal reject, no third send
    await rejected
    expect(posted).toHaveLength(2)
    expect(client.pending.size).toBe(0)
  })

  it('a second timed-out call still gets its own retry (per-call, not per-client-lifetime)', async () => {
    vi.useFakeTimers()
    const { client, posted } = makeRpcClient()
    const first = client._rpc('write', { path: 'a.txt' }, { opId: 'op-1', timeout: 1000 })
    const firstRejected = expect(first).rejects.toThrow('timeout (after retry)')
    await vi.advanceTimersByTimeAsync(2000)
    await firstRejected

    const second = client._rpc('write', { path: 'b.txt' }, { opId: 'op-2', timeout: 1000 })
    const secondRejected = expect(second).rejects.toThrow('timeout (after retry)')
    await vi.advanceTimersByTimeAsync(1000)
    // The second call retried too — 2 sends for op-1 + 2 sends for op-2.
    expect(posted.filter((m) => m.opId === 'op-2')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1000)
    await secondRejected
  })

  it('an opId-less RPC with a timeout rejects on first timeout without a retry', async () => {
    vi.useFakeTimers()
    const { client, posted } = makeRpcClient()
    const p = client._rpc('compact', {}, { timeout: 500 })
    const rejected = expect(p).rejects.toThrow('compact timeout')
    await vi.advanceTimersByTimeAsync(500)
    await rejected
    expect(posted).toHaveLength(1)
  })
})
