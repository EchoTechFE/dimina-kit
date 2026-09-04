/**
 * The grace-window bound of {@link createCoiServerShutdown}'s `drain`/`close`:
 * a request that never finishes must not hold teardown open forever. Runs
 * against a plain http.Server rather than the full workbench COI server so the
 * grace window can be set short and the test stays fast.
 */
import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { createCoiServerShutdown } from './workbench-coi-shutdown.js'

let server: http.Server | null = null

afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
})

describe('drain grace period destroys a stalled in-flight request', () => {
  it('returns close() within the grace window and destroys the response that never ended', async () => {
    const graceMs = 50
    const shutdown = createCoiServerShutdown(graceMs)
    // Boxed rather than a bare `let`: TS narrows a bare closure-assigned `let`
    // to `never` at the read site below, since it cannot see the assignment
    // happens before the read.
    const served: { res: http.ServerResponse | null } = { res: null }
    let mark: () => void = () => {}
    const serving = new Promise<void>((resolve) => { mark = resolve })

    server = http.createServer((req, res) => {
      shutdown.trackRequest(res)
      served.res = res
      mark()
      // Deliberately never calls res.end() — this stands in for a
      // `/__fs/write` whose client stalled halfway through the body.
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/x' })
    req.on('error', () => {}) // a destroyed socket surfaces here on the client side
    req.flushHeaders()
    req.write('partial-body-that-never-ends')
    await serving

    const start = Date.now()
    await shutdown.close(server)
    const elapsed = Date.now() - start

    // Bounded: teardown does not wait for a client that will never finish.
    expect(elapsed).toBeLessThan(graceMs + 1000)
    // The grace timer actually ran rather than resolving for some other
    // reason (e.g. inFlight being empty from the start).
    expect(elapsed).toBeGreaterThanOrEqual(graceMs - 5)
    expect(served.res?.destroyed).toBe(true)

    req.destroy()
  })

  it('does not wait out the grace window when nothing is in flight', async () => {
    const graceMs = 2_000
    const shutdown = createCoiServerShutdown(graceMs)
    server = http.createServer((req, res) => { shutdown.trackRequest(res) })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))

    const start = Date.now()
    await shutdown.close(server)
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(graceMs)
  })
})
