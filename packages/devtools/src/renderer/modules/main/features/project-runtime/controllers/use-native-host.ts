import { useEffect, useState } from 'react'
import { invoke as ipcInvoke } from '@/shared/api/ipc-transport'
import { WorkbenchRuntimeChannel } from '../../../../../../shared/ipc-channels'

// The native-host flag is fixed for the process lifetime, so resolve it once
// and memoize the promise across every hook consumer (WXML + AppData panels).
let cached: Promise<boolean> | null = null
function queryNativeHost(): Promise<boolean> {
  if (!cached) {
    cached = ipcInvoke<boolean | undefined>(WorkbenchRuntimeChannel.GetNativeHost)
      .then((v) => v === true)
      .catch(() => false)
  }
  return cached
}

/**
 * Whether the workbench is running the native-host container. Under native-host
 * the page DOM / service logic live in separate webContents, so the WXML +
 * AppData panels source their data from the main process instead of the
 * simulator guest's miniappSnapshot transport. Returns `false` until the
 * one-shot query resolves (the default/safe assumption).
 */
export function useNativeHost(): boolean {
  const [nativeHost, setNativeHost] = useState(false)
  useEffect(() => {
    let cancelled = false
    void queryNativeHost().then((v) => {
      if (!cancelled) setNativeHost(v)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return nativeHost
}
