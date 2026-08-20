import { useEffect, useRef } from 'react'
import { hideTooltip, showTooltip } from '@/shared/api'

const SHOW_DELAY_MS = 400

/**
 * Hover-triggered label for a toolbar trigger, backed by the tooltip overlay
 * WebContentsView (`@/shared/api`'s `showTooltip`/`hideTooltip`) — NOT the
 * `ui/tooltip` Radix component and NOT the native `title` attribute. Both of
 * those render inside the main window's own paint surface, which any other
 * WebContentsView mounted on top of it (simulator, editor, settings, popover)
 * occludes; CSS z-index and the OS's own tooltip layer can't reach across
 * that boundary. See `TooltipChannel`'s doc-comment (shared/ipc-channels.ts).
 *
 * Spread the returned props onto the trigger element: `<Button
 * {...useOverlayTooltip(label)} .../>`. Still set `aria-label` yourself —
 * this hook is purely the hover-visual, not an accessible name.
 */
export function useOverlayTooltip(label: string) {
  const ref = useRef<HTMLButtonElement>(null)
  const timerRef = useRef<number | undefined>(undefined)
  // Tracks whether a showTooltip actually went out (not just scheduled) —
  // hide() only needs to fire (and unmount only needs to clean up) when
  // that's true. A trigger that renders/unmounts without ever being hovered
  // (most components, most of the time) then sends no IPC at all.
  const shownRef = useRef(false)

  function handleMouseEnter() {
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      shownRef.current = true
      showTooltip({
        anchor: { x: r.x, y: r.y, width: r.width, height: r.height },
        text: label,
      })
    }, SHOW_DELAY_MS)
  }

  function handleMouseLeave() {
    window.clearTimeout(timerRef.current)
    if (!shownRef.current) return
    shownRef.current = false
    hideTooltip()
  }

  // Unmounting mid-hover (e.g. the toggle it labels disappears from the dock)
  // must not leave a stale tooltip pointing at a dead anchor.
  useEffect(() => handleMouseLeave, [])

  return { ref, onMouseEnter: handleMouseEnter, onMouseLeave: handleMouseLeave }
}
