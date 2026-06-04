import { useCallback, useEffect, useState } from 'react'
import { invoke as ipcInvoke, on as ipcOn } from '@/shared/api/ipc-transport'

export interface NativeChannelSnapshotOptions<T> {
  /** invoke channel that returns the current snapshot (refresh / seed). */
  getChannel: string
  /** push channel main sends a fresh snapshot on. */
  eventChannel: string
  initial: T
  /** Only seed/subscribe when true (native-host + compile ready). */
  enabled: boolean
}

export interface NativeChannelSnapshotResult<T> {
  data: T
  refresh: () => void
}

/**
 * Native-host panel data source: seed via an invoke channel and stay reactive
 * via a main→renderer push channel. Mirrors how the Storage panel already
 * consumes main-process data, so WXML + AppData can drop the simulator-guest
 * miniappSnapshot transport under native-host without changing their panels.
 */
export function useNativeChannelSnapshot<T>(
  opts: NativeChannelSnapshotOptions<T>,
): NativeChannelSnapshotResult<T> {
  const { getChannel, eventChannel, initial, enabled } = opts
  const [data, setData] = useState<T>(initial)

  const refresh = useCallback(() => {
    if (!enabled) return
    void ipcInvoke<T | undefined>(getChannel).then((value) => {
      if (value !== undefined) setData(value)
    })
  }, [enabled, getChannel])

  // Seed once when enabled flips on (or the channel changes).
  useEffect(() => {
    if (!enabled) return
    refresh()
  }, [enabled, refresh])

  // Live updates pushed by the main process.
  useEffect(() => {
    if (!enabled) return
    return ipcOn<[T]>(eventChannel, (value) => setData(value))
  }, [enabled, eventChannel])

  return { data, refresh }
}
