/** URL schemes that can carry the mini-app author's own business traffic. */
const USER_FACING_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:'])

/**
 * Judges whether a captured network request belongs on the user-facing
 * (right-panel) DevTools Network tab, or should be hidden there — a
 * framework/host-internal resource load, visible only in the standalone
 * internal DevTools window's unfiltered global mirror.
 *
 * Single source of truth for the split (network-forward's user-facing sink
 * and the global mirror both key off this): scheme must be one of
 * http/https/ws/wss, AND the request's origin must not match ANY of
 * `internalOrigins` — each is a base URL of a server this app itself runs
 * whose own traffic is host-internal, not the developer's business traffic.
 * There are currently two: the resource server (serves the compiled
 * mini-app bundle) and the simulator's own static-asset server (serves
 * `simulator.html` + its JS/CSS — a THIRD-PARTY-to-the-user-code origin the
 * `attachSimulator` CDP session also observes, since it captures the whole
 * simulator WebContentsView's network activity, not just the mini-app's own
 * `wx.request` calls). `null`/`undefined` entries (a server not currently
 * running, e.g. no project open) are skipped, not treated as a match.
 */
export function isUserFacingRequest(
  url: string,
  internalOrigins?: ReadonlyArray<string | null | undefined>,
): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // Real CDP `Network.requestWillBeSent.request.url` is always a fully
    // qualified URL — this only happens for hand-authored test/placeholder
    // input. Fail OPEN (treat as user-facing): hiding a request the caller
    // couldn't even classify risks silently swallowing real business
    // traffic, a worse outcome than occasionally over-showing something.
    return true
  }
  if (!USER_FACING_SCHEMES.has(parsed.protocol)) return false
  for (const baseUrl of internalOrigins ?? []) {
    if (!baseUrl) continue
    try {
      if (parsed.origin === new URL(baseUrl).origin) return false
    } catch {
      // Malformed baseUrl — can't compare, so don't let it hide anything.
    }
  }
  return true
}
