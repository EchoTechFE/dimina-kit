import { useState } from 'react'

/**
 * Derive which AppData page tab is active, synchronously.
 *
 * `activeBridgeId` is a pure derivation of (current bridges, manual pick),
 * computed during render — so it is never stale for a frame the way a
 * useEffect-derived value would be. When a brand-new bridge id appears
 * (a page just inited) the panel snaps to it, overriding any manual pick.
 */
export function useActiveBridgeId(
  bridges: ReadonlyArray<{ id: string; pagePath: string | null }>,
): { activeBridgeId: string | null; setActiveBridge: (id: string) => void } {
  const ids = bridges.map((b) => b.id)
  // NUL separator: ids are runtime-generated and never contain it, so two
  // distinct id lists can never collide on the same key.
  const idsKey = ids.join('\x00')

  // The user's manual tab pick; null means "auto-follow the newest page".
  const [selectedBridgeId, setSelectedBridgeId] = useState<string | null>(null)
  // The id list from the previous render — lets us spot a freshly-inited page.
  const [prevIdsKey, setPrevIdsKey] = useState('')

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

  const activeBridgeId
    = selectedBridgeId && ids.includes(selectedBridgeId)
      ? selectedBridgeId
      : (ids.at(-1) ?? null)

  const setActiveBridge = (id: string): void => {
    if (ids.includes(id)) setSelectedBridgeId(id)
  }

  return { activeBridgeId, setActiveBridge }
}
