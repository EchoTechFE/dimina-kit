import { useCallback, useEffect, useRef } from 'react'
import { publishWorkbenchA2Bounds } from '@/shared/api'
import { createPlacementAnchor, type Placement, type PlacementAnchorHandle } from '@dimina-kit/view-anchor'
import { useDockLayoutEpoch } from '@dimina-kit/electron-deck/dock-react'

// The editor is the embedded A2 VS Code workbench: a main-process
// WebContentsView painted directly over this DOM dock body. This renderer panel
// draws NO chrome — the body is a single full-size anchor div over which the
// workbench WCV is overlaid (the workbench renders its own toolbar/tabs inside
// its WebContents, whose DOM lives in a separate process and never appears in
// the main window).
//
// This component is the SOLE workbench-WCV anchor owner. It binds an imperative
// `createPlacementAnchor` to the body div and maps its placement to
// `publishWorkbenchA2Bounds` → main's `setWorkbenchA2Bounds`. The first non-zero
// bounds lazily attaches the workbench WCV (the lazy-load contract), so the
// anchor must publish a live rect as soon as the editor body is on screen.
//
// Under DOM-panel keepalive the body is NOT unmounted when its dock tab
// deactivates — its slot merely goes `display:none`. To collapse the WCV on
// deactivation it opts into view-anchor's `guardDisplayNone`: an
// IntersectionObserver re-fires on a `display:none` transition (invisible to
// ResizeObserver) and the resulting zero-area measure becomes a
// `{ visible:false }` publish, which `publish` maps to COLLAPSED 0×0 bounds
// (detach-but-keep-alive). `followScroll` + `followGeometry` keep the WCV glued
// to the slot as ancestors scroll or the slot is moved without resizing.
export function EditorPanel() {
  const anchorHandleRef = useRef<PlacementAnchorHandle | null>(null)

  const publish = useCallback((p: Placement) => {
    if (p.visible) {
      void publishWorkbenchA2Bounds({
        x: p.bounds.x,
        y: p.bounds.y,
        width: p.bounds.width,
        height: p.bounds.height,
      })
    } else {
      // Hidden → collapse the WCV (main treats 0×0 as detach-but-keep-alive).
      void publishWorkbenchA2Bounds({ x: 0, y: 0, width: 0, height: 0 })
    }
  }, [])

  // Ref-callback binding the placement anchor to the editor body div. Mirrors
  // the dock native-slot lifecycle: bind on mount, rebind without a hidden flash
  // on element swap, publish-hidden-then-dispose on unmount.
  const anchorRef = useCallback(
    (el: HTMLDivElement | null) => {
      const existing = anchorHandleRef.current
      if (existing) {
        if (el) {
          existing.dispose()
          anchorHandleRef.current = createPlacementAnchor(el, {
            visible: true,
            guardDisplayNone: true,
            followScroll: true,
            followGeometry: true,
            publish,
          })
        } else {
          existing.update({ visible: false, publish })
          existing.dispose()
          anchorHandleRef.current = null
        }
        return
      }
      if (el) {
        anchorHandleRef.current = createPlacementAnchor(el, {
          visible: true,
          guardDisplayNone: true,
          followScroll: true,
          followGeometry: true,
          publish,
        })
      }
    },
    [publish],
  )

  // Follow a pure-translate layout reorder. A dock preset change reorders this
  // panel's slot without resizing it, so the anchor's ResizeObserver never fires
  // and the native WCV would freeze at its old position. `useDockLayoutEpoch`
  // bumps on every committed layout mutation; pulsing the anchor on that edge
  // opens the `followGeometry` RAF sentinel for a few frames AFTER React commits
  // the reorder, re-measuring the moved slot and re-publishing the rect (the
  // sentinel auto-closes once the geometry goes steady). Outside a `<DockView>`
  // the epoch is a constant 0 and this never re-fires.
  const layoutEpoch = useDockLayoutEpoch()
  useEffect(() => {
    anchorHandleRef.current?.pulse(300)
  }, [layoutEpoch])

  // Hard-unmount safety: the ref-callback `null` cleanup also disposes, but a
  // teardown that skips the ref cleanup must not leak a live anchor.
  useEffect(() => {
    return () => {
      anchorHandleRef.current?.dispose()
      anchorHandleRef.current = null
    }
  }, [])

  return <div ref={anchorRef} className="h-full w-full" data-area="editor" />
}
