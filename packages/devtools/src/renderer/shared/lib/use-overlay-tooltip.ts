import { useEffect, useRef } from 'react'
import { hideTooltip, showTooltip } from '@/shared/api'

const SHOW_DELAY_MS = 400
let visibleOwner: symbol | null = null

function showFor(owner: symbol, label: string, anchor: DOMRect): void {
  visibleOwner = owner
  showTooltip({
    anchor: { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height },
    text: label,
  })
}

function hideFor(owner: symbol): void {
  if (visibleOwner !== owner) return
  visibleOwner = null
  hideTooltip()
}

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
  const ownerRef = useRef(Symbol('overlay-tooltip-owner'))

  function handleMouseEnter() {
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      const el = ref.current
      if (!el) return
      showFor(ownerRef.current, label, el.getBoundingClientRect())
    }, SHOW_DELAY_MS)
  }

  function handleMouseLeave() {
    window.clearTimeout(timerRef.current)
    hideFor(ownerRef.current)
  }

  // Unmounting mid-hover (e.g. the toggle it labels disappears from the dock)
  // must not leave a stale tooltip pointing at a dead anchor.
  useEffect(() => handleMouseLeave, [])

  return { ref, onMouseEnter: handleMouseEnter, onMouseLeave: handleMouseLeave }
}
