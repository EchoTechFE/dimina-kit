import { describe, expect, it } from 'vitest'
import { createRequestTracer, type NativeRequestTrace } from './trace.js'

describe('native HTTP observation bounds', () => {
  it('does not allocate base64 when a small compressed response expands beyond the cache budget', () => {
    const events: NativeRequestTrace[] = []
    const tracer = createRequestTracer(() => (_owner, event) => events.push(event), 'owner', 'r')
    let allocations = 0
    tracer.finished(() => { allocations++; return 'body' }, true, 1024, 17 * 1024 * 1024)
    expect(allocations).toBe(0)
    expect(events[0]).toMatchObject({ type: 'finished', encodedDataLength: 1024 })
    expect((events[0] as { body?: string }).body).toBeUndefined()
  })

  it('keeps oversized POST data out of the trace while reporting that a body exists', () => {
    const events: NativeRequestTrace[] = []
    const tracer = createRequestTracer(() => (_owner, event) => events.push(event), 'owner', 'r')
    tracer.sent('https://example.com', 'POST', {}, 'a'.repeat(17 * 1024 * 1024))
    expect((events[0] as { postData?: string }).postData?.length).toBeUndefined()
    expect(events[0]).toMatchObject({ hasPostData: true })
  })

  it('omits an oversized body while preserving completion and actual byte count', () => {
    const events: NativeRequestTrace[] = []
    const tracer = createRequestTracer(() => (_owner, event) => events.push(event), 'owner', 'r')
    tracer.sent('https://example.com', 'GET', {})
    tracer.finished('a'.repeat(17 * 1024 * 1024), true, 13 * 1024 * 1024)
    expect(events[1]).toMatchObject({ type: 'finished', encodedDataLength: 13 * 1024 * 1024 })
    expect((events[1] as { body?: string }).body).toBeUndefined()
  })
})
