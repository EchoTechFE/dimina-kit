// The AppData panel's data wiring, written once against AppDataPanelSource:
// seed on the (enabled && active) rising edge, stay live by replacing state
// with each pushed full snapshot, forward the visibility gate, and own the
// bridge-tab selection (auto-follow of the simulator's active page + manual
// picks). Hosts render this with their transport implementation (Electron
// IPC, a same-origin Worker tap, …) and the pure AppDataPanel view underneath
// never needs host-specific code.
import { useState } from 'react'
import { AppDataPanel } from './appdata-panel-view.js'
import { useActiveBridgeId } from './use-active-bridge-id.js'
import { useSourceWiring } from './use-source-wiring.js'
import type { AppDataPanelSource } from './appdata-source.js'
import type { AppDataSnapshot } from './appdata-accumulator.js'

export interface ConnectedAppDataPanelProps {
  source: AppDataPanelSource
  /** Panel visibility (the host's tab-active state). Defaults to true. */
  active?: boolean
  /** Data availability gate (e.g. compile ready). While false the panel makes
   * no source calls at all and keeps the last rendered snapshot. Defaults to
   * true. */
  enabled?: boolean
  isRuntimeRunning?: boolean
  /** The simulator's active page path; the bridge tabs auto-follow it. */
  activePagePath?: string
}

const EMPTY_SNAPSHOT: AppDataSnapshot = { bridges: [], entries: {} }

export function ConnectedAppDataPanel({
  source,
  active = true,
  enabled = true,
  isRuntimeRunning = true,
  activePagePath = '',
}: ConnectedAppDataPanelProps) {
  const [snapshot, setSnapshot] = useState<AppDataSnapshot>(EMPTY_SNAPSHOT)

  useSourceWiring({
    source,
    enabled,
    active,
    subscribe: s => s.subscribe((next) => {
      setSnapshot(next)
    }),
    seed: (s, isDisposed) => {
      void s.getSnapshot().then((next) => {
        if (!isDisposed()) setSnapshot(next)
      })
    },
  })

  const { activeBridgeId, setActiveBridge } = useActiveBridgeId(snapshot.bridges, activePagePath)

  // Only a source with a write-back channel makes the tree editable; the
  // authoritative new value arrives back through the snapshot push, so the
  // dispatch result is not awaited here.
  const setData = source.setData?.bind(source)
  const onSetData = setData
    ? (bridgeId: string, patch: Record<string, unknown>): void => { void setData(bridgeId, patch) }
    : undefined

  return (
    <AppDataPanel
      state={{ bridges: snapshot.bridges, activeBridgeId, entries: snapshot.entries }}
      onSelectBridge={setActiveBridge}
      isRuntimeRunning={isRuntimeRunning}
      onSetData={onSetData}
    />
  )
}
