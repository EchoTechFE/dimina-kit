/**
 * Firing a spawned service window's `did-finish-load` is what real navigation
 * completing looks like from main's perspective: `bootServiceHost` runs, the
 * session flips to ready, and everything `forwardToService` queued until then
 * is flushed. A suite that drives a session past spawn must fire it, or its
 * lifecycle sends sit in that queue and never reach the fake service host.
 *
 * The listener is registered with `.once` on the fresh (non-pooled) spawn path
 * these suites' fake contexts always take.
 */
export function fireServiceDidFinishLoad(
  serviceWc: { once: { mock: { calls: ReadonlyArray<readonly unknown[]> } } },
): void {
  const call = serviceWc.once.mock.calls.find(([channel]) => channel === 'did-finish-load')
  if (!call) throw new Error('service webContents never registered a did-finish-load listener')
  ;(call[1] as () => void)()
}
