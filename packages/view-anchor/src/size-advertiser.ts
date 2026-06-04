import type {
  AdvertisedSize,
  SizeAdvertiserOptions,
  SizeAdvertiserHandle,
} from './types.js'
import { createMeasureLoop } from './measure-loop.js'

/**
 * Reverse of `createViewAnchor`: runs in a downstream WebContentsView's own
 * renderer, measures the content's own size on ONE owned axis (from the
 * `ResizeObserver` border-box — no `getBoundingClientRect`, no forced reflow),
 * and advertises it via the injected `publish`. Shares the forward primitive's
 * measure/coalesce/dedupe/dispose engine (`createMeasureLoop`).
 *
 * The extent is `Math.round`ed and clamped to `>= 0`; non-finite measurements
 * drop the frame.
 *
 * FOOTGUN — `target` must be shrink-to-fit on the owned axis: its owned-axis
 * size must NOT be driven by the host-applied view size, or the cross-process
 * loop (advertise → host resizes view → remeasure) never converges (it
 * oscillates or stays "stable but wrong"). Measuring `<body>`/`<html>` is the
 * classic mistake — their size *is* the view size. See
 * `docs/bidirectional-design.md` §4/§5.
 */
export function createSizeAdvertiser(
  target: HTMLElement,
  opts: SizeAdvertiserOptions,
): SizeAdvertiserHandle {
  const axis = opts.axis // immutable for the advertiser's life
  let publish = opts.publish
  let observer: ResizeObserver | null = null
  let disposed = false
  // Latest border-box, stashed by the RO callback and read by `produce` in the
  // RAF body (keep the entry out of the shared, DOM-agnostic loop).
  let latest: ResizeObserverSize | null = null

  const produce = (): AdvertisedSize | null => {
    if (!latest) return null
    const raw = axis === 'block' ? latest.blockSize : latest.inlineSize
    if (!Number.isFinite(raw)) return null
    return { axis, extent: Math.max(0, Math.round(raw)) }
  }

  const loop = createMeasureLoop<AdvertisedSize>({
    produce,
    same: (a, b) => a.extent === b.extent, // axis is constant
    sink: (size) => publish(size),
  })

  const onResize: ResizeObserverCallback = (entries) => {
    const entry = entries[entries.length - 1]
    if (entry) {
      latest = entry.borderBoxSize?.[0] ?? entry.contentBoxSize?.[0] ?? latest
    }
    loop.schedule()
  }

  // One cheap, once-per-advertiser guard for the textbook feedback-loop footgun.
  const doc = target.ownerDocument
  if (target === doc.body || target === doc.documentElement) {
    console.warn(
      `[view-anchor] size-advertiser: <${target === doc.body ? 'body' : 'html'}>'s ` +
        `${axis} size is the host-given view size, not the content size — the ` +
        `advertiser will never shrink to content. Measure a shrink-to-fit wrapper. ` +
        `See bidirectional-design.md §4.`,
    )
  }

  loop.setActive(true)
  observer = new ResizeObserver(onResize)
  observer.observe(target)

  return {
    update(nextPublish: (size: AdvertisedSize) => void): void {
      if (disposed) return
      publish = nextPublish
      // Re-advertise the current size to the new sink immediately (mirrors the
      // forward anchor's re-publish on update) so the new channel is not left
      // sizeless until the next ResizeObserver tick.
      const cur = produce()
      if (cur) loop.emitNow(cur)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      loop.cancel()
      if (observer) {
        observer.disconnect()
        observer = null
      }
      loop.dispose()
    },
  }
}
