// The Storage panel's data wiring, written once against StoragePanelSource:
// seed on the (enabled && active) rising edge, stay live by reducing the
// push subscription's StorageEvents into the item list, forward the
// visibility gate, and route the panel's writes. Hosts render this with
// their transport implementation (Electron IPC, same-origin localStorage +
// `storage` events, …) and the pure StoragePanel view underneath never
// needs host-specific code.
import { useState } from 'react'
import { StoragePanel } from './storage-panel-view.js'
import { applyStorageEvent } from './storage-reducer.js'
import { useSourceWiring } from './use-source-wiring.js'
import type { StoragePanelSource } from './storage-source.js'
import type { StorageItem } from './storage-types.js'

export interface ConnectedStoragePanelProps {
  source: StoragePanelSource
  /** Panel visibility (the host's tab-active state). Defaults to true. */
  active?: boolean
  /** Data availability gate (e.g. compile ready). While false the panel makes
   * no source calls at all and keeps the last rendered items. Defaults to true. */
  enabled?: boolean
  isRuntimeRunning?: boolean
}

export function ConnectedStoragePanel({
  source,
  active = true,
  enabled = true,
  isRuntimeRunning = true,
}: ConnectedStoragePanelProps) {
  const [items, setItems] = useState<StorageItem[]>([])

  useSourceWiring({
    source,
    enabled,
    active,
    subscribe: s => s.subscribe((evt) => {
      setItems(prev => applyStorageEvent(prev, evt))
    }),
    seed: (s, isDisposed) => {
      void s.getSnapshot().then((next) => {
        if (!isDisposed()) setItems(next)
      })
    },
  })

  // clearAll is re-bound per source: passing it through only when the source
  // has the capability is what makes the view hide the origin-wide wipe.
  const clearAll = source.clearAll?.bind(source)

  return (
    <StoragePanel
      items={items}
      onSet={(key, value) => source.setItem(key, value)}
      onRemove={key => source.removeItem(key)}
      onClear={() => source.clear()}
      onClearAll={clearAll}
      getPrefix={() => source.getPrefix()}
      isRuntimeRunning={isRuntimeRunning}
    />
  )
}
