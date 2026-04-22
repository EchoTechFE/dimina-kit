import { ipcRenderer } from 'electron'
import { BridgeChannel, SimulatorChannel } from '../../shared/ipc-channels.js'
import { sendToHost } from '../runtime/host.js'
import {
  setStorageSnapshot,
  clearStorageSnapshot,
} from '../runtime/bridge.js'
import { createDisposableSet } from './disposable.js'

const STORAGE_PREFIX = /^#\/?/

function getStorageNamespace(): string | null {
  const hash = window.location.hash || ''
  const normalized = hash.replace(STORAGE_PREFIX, '')
  // New format: appid|page1|page2 — first segment is appid
  // Legacy format: appid/pages/xxx?query
  const candidate = normalized.split(/[|/?&]/, 1)[0]?.trim()
  return candidate ? candidate : null
}

function normalizeStorageKey(rawKey: string, namespace: string): string | null {
  const prefix = `${namespace}_`
  if (!rawKey.startsWith(prefix)) return null
  return rawKey.slice(prefix.length)
}

function readSnapshot(namespace: string | null): Record<string, string> {
  if (!namespace) return {}
  const items: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key) continue
    const normalized = normalizeStorageKey(key, namespace)
    if (normalized === null) continue
    items[normalized] = localStorage.getItem(key) ?? ''
  }
  return items
}

function syncSnapshot(namespace: string | null): void {
  if (!namespace) {
    clearStorageSnapshot()
    return
  }
  setStorageSnapshot(namespace, readSnapshot(namespace))
}

export function installStorageInstrumentation(): () => void {
  const originalSetItem = localStorage.setItem.bind(localStorage)
  const originalRemoveItem = localStorage.removeItem.bind(localStorage)
  const namespaceRef = { value: getStorageNamespace() }

  const handleNamespaceChange = () => {
    namespaceRef.value = getStorageNamespace()
    syncSnapshot(namespaceRef.value)
  }

  const handleSetItem = (key: string, value: string) => {
    const namespace = namespaceRef.value
    originalSetItem(key, value)
    if (namespace) {
      const normalized = normalizeStorageKey(key, namespace)
      if (normalized !== null) {
        const snapshot = readSnapshot(namespace)
        setStorageSnapshot(namespace, snapshot)
        sendToHost(SimulatorChannel.Storage, {
          namespace,
          action: 'set',
          key: normalized,
          rawKey: key,
          value,
          ts: Date.now(),
        })
      }
    }
  }

  const handleRemoveItem = (key: string) => {
    const namespace = namespaceRef.value
    originalRemoveItem(key)
    if (namespace) {
      const normalized = normalizeStorageKey(key, namespace)
      if (normalized !== null) {
        const snapshot = readSnapshot(namespace)
        setStorageSnapshot(namespace, snapshot)
        sendToHost(SimulatorChannel.Storage, {
          namespace,
          action: 'remove',
          key: normalized,
          rawKey: key,
          ts: Date.now(),
        })
      }
    }
  }

  const handleStorageGetAll = () => {
    const namespace = namespaceRef.value
    if (!namespace) return
    const snapshot = readSnapshot(namespace)
    const items = Object.entries(snapshot).map(([key, value]) => ({ key, value }))
    sendToHost(SimulatorChannel.StorageAll, items)
  }

  const disposables = createDisposableSet()

  localStorage.setItem = handleSetItem
  localStorage.removeItem = handleRemoveItem
  window.addEventListener('hashchange', handleNamespaceChange)
  ipcRenderer.on(BridgeChannel.StorageGetAllRequest, handleStorageGetAll)
  syncSnapshot(namespaceRef.value)

  disposables.add(() => {
    localStorage.setItem = originalSetItem
    localStorage.removeItem = originalRemoveItem
  })
  disposables.add(() => {
    window.removeEventListener('hashchange', handleNamespaceChange)
  })
  disposables.add(() => {
    ipcRenderer.removeListener(BridgeChannel.StorageGetAllRequest, handleStorageGetAll)
  })
  disposables.add(() => {
    clearStorageSnapshot()
  })

  return () => {
    disposables.disposeAll()
  }
}
