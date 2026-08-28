import { useEffect, useMemo, useState } from 'react'
import { createPlacementPublisher, type PlacementPublisher } from '@dimina-kit/electron-deck/client'
import { publishPlacementSnapshot } from '@/shared/api'
import { nextPlacementGeneration } from '@/shared/renderer-placement-generation'
import type { DevtoolsExtra } from '../../shared/view-ids'

/**
 * The single placement publisher owned by a top-level screen. Each native-view
 * anchor in that screen writes its desired placement here; the publisher
 * coalesces one window-level snapshot per frame and forwards it to main's
 * reconciler. A fresh generation per mount makes the reconciler drop the
 * previous screen's actual-view table.
 *
 * The generation is drawn from the shared cross-screen sequence (see
 * `renderer-placement-generation.ts`) so a later mount of ANY screen always
 * compares as later than a generation another screen already sent — with two
 * independent per-screen counters, one screen can send main a generation lower
 * than one it already accepted, which the reconciler treats as permanently
 * stale.
 *
 * Every screen that owns host slots must take its publisher from here rather
 * than building its own, so this ordering guarantee has one implementation.
 */
export function useScreenPlacementPublisher(): PlacementPublisher<DevtoolsExtra> {
  const [generation] = useState(() => nextPlacementGeneration())
  const publisher = useMemo<PlacementPublisher<DevtoolsExtra>>(
    () => createPlacementPublisher<DevtoolsExtra>({
      generation,
      publish: (snapshot) => { void publishPlacementSnapshot(snapshot) },
    }),
    [generation],
  )
  useEffect(() => () => publisher.dispose(), [publisher])
  return publisher
}

/**
 * Track a host slot's advertised extent (the toolbar's height, the sidebar's
 * width) with a mount-time REPLAY.
 *
 * The extent chain is push-based and the slot's size-advertiser deduplicates
 * (an extent already reported is never re-sent), so any push that fired before
 * the consuming screen mounted is lost outright — cold start races it, and
 * close-project → reopen hits it deterministically because the screen is
 * rebuilt at its seed. Main retains the last notified extent, so the fix is to
 * pull it at mount; `subscribe` must run FIRST, because a push landing between
 * the pull and the subscribe would be lost exactly like the original bug, and
 * a push that lands while the pull is in flight must win over the staler pull
 * result (the TOCTOU guard below).
 *
 * `initial` is the value the extent holds until the first push or pull lands.
 * Pass 0 for a slot that is genuinely absent until a host fills it; pass a
 * known content width for a slot whose default content main loads itself (see
 * `HOST_SIDEBAR_DEFAULT_WIDTH`) — there a 0 seed is a structural deadlock, not
 * merely a slower initial value, because the placeholder only becomes visible
 * at a nonzero extent, the slot's WCV only attaches once the placeholder is
 * visible, and the WCV's own advertiser only ever reports through
 * `requestAnimationFrame`, which Chromium never schedules for an unattached
 * WebContentsView.
 *
 * `subscribe` and `pull` must be referentially stable across renders (pass the
 * module-level API functions directly, not inline closures) — they are effect
 * dependencies, and a fresh identity each render would re-subscribe and
 * re-pull, letting the new pull's staler result overwrite a push that already
 * landed.
 */
export function useHostSlotExtent(
  initial: number,
  subscribe: (handler: (extent: number) => void) => () => void,
  pull: () => Promise<number | undefined>,
): number {
  const [extent, setExtent] = useState(initial)
  useEffect(() => {
    let pushReceived = false
    const unsubscribe = subscribe((next) => {
      pushReceived = true
      setExtent(next)
    })
    void pull().then((pulled) => {
      // A fresher push won the race while the pull was in flight — applying
      // the stale pull result would snap the strip back.
      if (pushReceived) return
      // The lenient invoke resolves undefined on main-side failure: keep the
      // seed and let live pushes drive it.
      if (typeof pulled === 'number') setExtent(pulled)
    })
    return unsubscribe
  }, [subscribe, pull])
  return extent
}
