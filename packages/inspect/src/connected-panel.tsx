// The WXML panel's data wiring, written once against WxmlPanelSource: seed on
// the (enabled && active) rising edge, stay live through the push
// subscription, forward the visibility gate, and route hover inspection.
// Hosts render this with their transport implementation (Electron IPC,
// preview-iframe postMessage, …) and the pure WxmlPanel view underneath never
// needs host-specific code.
import { useState } from 'react'
import { WxmlPanel } from './panel-view.js'
import { useSourceWiring } from './use-source-wiring.js'
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

  useSourceWiring({
    source,
    enabled,
    active,
    subscribe: s => s.subscribe(setTree),
    seed: (s, isDisposed) => {
      void s.getSnapshot().then((next) => {
        if (!isDisposed()) setTree(next)
      })
    },
  })

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
