// The WXML panel's data wiring, written once against WxmlPanelSource: seed on
// the (enabled && active) rising edge, stay live through the push
// subscription, forward the visibility gate, and route hover inspection.
// Hosts render this with their transport implementation (Electron IPC,
// preview-iframe postMessage, …) and the pure WxmlPanel view underneath never
// needs host-specific code.
import { useEffect, useRef, useState } from 'react'
import { WxmlPanel } from './panel-view.js'
import type { WxmlPanelSource } from './panel-source.js'
import type { WxmlNode } from './types.js'

export interface ConnectedWxmlPanelProps {
  source: WxmlPanelSource
  /** Panel visibility (the host's tab-active state). Defaults to true. */
  active?: boolean
  /** Data availability gate (e.g. compile ready). While false the panel makes
   * no source calls at all and keeps the last rendered tree. Defaults to true. */
  enabled?: boolean
  isRuntimeRunning?: boolean
}

export function ConnectedWxmlPanel({
  source,
  active = true,
  enabled = true,
  isRuntimeRunning = true,
}: ConnectedWxmlPanelProps) {
  const [tree, setTree] = useState<WxmlNode | null>(null)

  // Subscription + observer-gate lifecycle, per (source, enabled). Cleanup
  // turns the producer's observer off so an unmounted/disabled panel never
  // drives a tree walk; a source swap tears the old transport down first.
  useEffect(() => {
    if (!enabled) return
    const unsubscribe = source.subscribe(setTree)
    return () => {
      unsubscribe()
      source.setActive(false)
    }
  }, [source, enabled])

  // Forward the visibility gate on every change while enabled.
  useEffect(() => {
    if (!enabled) return
    source.setActive(active)
  }, [source, enabled, active])

  // Seed on the (enabled && active) rising edge — including a source swap
  // while on. A kept-alive tab that turns active again re-fetches, so it never
  // shows a tree from before its invisible stretch. The disposed flag drops a
  // snapshot that resolves after cleanup (unmount or a newer seed).
  const prevSeed = useRef<{ source: WxmlPanelSource | null, on: boolean }>({ source: null, on: false })
  useEffect(() => {
    const on = enabled && active
    const prev = prevSeed.current
    const rising = on && (!prev.on || prev.source !== source)
    prevSeed.current = { source, on }
    if (!rising) return undefined
    let disposed = false
    void source.getSnapshot().then((next) => {
      if (!disposed) setTree(next)
    })
    return () => {
      disposed = true
    }
  }, [source, enabled, active])

  return (
    <WxmlPanel
      tree={tree}
      onInspectElement={sid => source.inspect(sid)}
      onClearInspection={async () => {
        await source.clearInspection()
      }}
      isRuntimeRunning={isRuntimeRunning}
    />
  )
}
