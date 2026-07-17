import { useState } from 'react'

function normalizePagePath(p: string | null | undefined): string {
  return (p ?? '').replace(/^\/+/, '')
}

/**
 * Derive which AppData page tab is active, synchronously.
 *
 * `activeBridgeId` is a pure derivation of (current bridges, the simulator's
 * active page, manual pick), computed during render — so it is never stale for
 * a frame the way a useEffect-derived value would be. Auto-follow tracks the
 * page the user is actually looking at: when `activePagePath` matches a
 * bridge's pagePath the panel snaps to it, so switching tabBar tabs (which
 * re-inits no bridge) still moves the panel. A brand-new bridge id appearing or
 * the active page changing both drop a prior manual pick back to auto-follow.
 */
export function useActiveBridgeId(
  bridges: ReadonlyArray<{ id: string; pagePath: string | null }>,
  activePagePath = '',
): { activeBridgeId: string | null; setActiveBridge: (id: string) => void } {
  const ids = bridges.map((b) => b.id)
  // NUL separator: ids are runtime-generated and never contain it, so two
  // distinct id lists can never collide on the same key.
  const idsKey = ids.join('\x00')

  // The user's manual tab pick; null means "auto-follow the active page".
  const [selectedBridgeId, setSelectedBridgeId] = useState<string | null>(null)
  // The id list from the previous render — lets us spot a freshly-inited page.
  const [prevIdsKey, setPrevIdsKey] = useState('')
  // The active page from the previous render — lets us spot a tab switch.
  const [prevActivePath, setPrevActivePath] = useState(activePagePath)

  if (idsKey !== prevIdsKey) {
    // The bridge set changed. If a never-before-seen id appeared, a new page
    // inited → drop back to auto-follow. Adjusting state during render is the
    // React-sanctioned alternative to an effect: React re-renders synchronously
    // before the commit, so `activeBridgeId` below is correct this frame.
    const prevIds = prevIdsKey ? prevIdsKey.split('\x00') : []
    if (ids.some((id) => !prevIds.includes(id))) {
      setSelectedBridgeId(null)
    }
    setPrevIdsKey(idsKey)
  }

  if (activePagePath !== prevActivePath) {
    // The simulator navigated to a different active page (e.g. a tabBar switch).
    // Drop the manual pick so the panel re-follows the page on screen — without
    // this, switching tabs leaves the panel stuck on whichever page inited last.
    setSelectedBridgeId(null)
    setPrevActivePath(activePagePath)
  }

  // Auto-follow target: the bridge whose pagePath matches the active page.
  const activeFollowId = activePagePath
    ? bridges.find((b) => normalizePagePath(b.pagePath) === normalizePagePath(activePagePath))?.id ?? null
    : null

  const activeBridgeId
    = selectedBridgeId && ids.includes(selectedBridgeId)
      ? selectedBridgeId
      // Prefer the active page; fall back to the newest bridge when the active
      // page is unknown or has no matching bridge yet.
      : (activeFollowId ?? ids.at(-1) ?? null)

  const setActiveBridge = (id: string): void => {
    if (ids.includes(id)) setSelectedBridgeId(id)
  }

  return { activeBridgeId, setActiveBridge }
}
