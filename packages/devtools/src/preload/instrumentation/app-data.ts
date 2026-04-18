import { SimulatorChannel, BridgeChannel } from '../../shared/ipc-channels.js'
import { sendToHost } from '../runtime/host.js'
import {
  simulatorBridge,
  clearAppDataSnapshot,
  setAppDataSnapshot,
} from '../runtime/bridge.js'
import { createDisposableSet } from './disposable.js'

// Window augmentation is in ../types.ts

type AppDataBody = {
  bridgeId?: string
  moduleId?: string
  data?: unknown
}

const appDataCache = new Map<string, unknown>()

function publishSnapshot(): void {
  const data: Record<string, unknown> = {}
  for (const [key, value] of appDataCache) {
    data[key] = value
  }
  setAppDataSnapshot(data)
}

function decodeWorkerMessage(message: unknown): AppDataBody | null {
  let payload = message
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch {
      return null
    }
  }

  const record = payload as { type?: string; body?: AppDataBody } | null
  if (record?.type !== 'u' || !record.body) return null
  return record.body
}

function createInstrumentedWorker(OriginalWorker: typeof Worker): typeof Worker {
  function InstrumentedWorker(
    this: unknown,
    scriptURL: string | URL,
    options?: WorkerOptions
  ): Worker {
    const resolvedScriptURL = scriptURL instanceof URL
      ? scriptURL
      : new URL(scriptURL, window.location.href)
    const worker = Reflect.construct(
      OriginalWorker,
      [resolvedScriptURL, options],
      new.target ?? InstrumentedWorker
    ) as Worker

    worker.addEventListener('message', (event: MessageEvent) => {
      const body = decodeWorkerMessage(event.data)
      if (!body) return
      window.__simulatorHook?.appData({
        bridgeId: body.bridgeId,
        moduleId: body.moduleId,
        data: body.data,
      })
    })

    return worker
  }

  Object.setPrototypeOf(InstrumentedWorker, OriginalWorker)
  Object.defineProperty(InstrumentedWorker, 'prototype', {
    value: OriginalWorker.prototype,
  })

  return InstrumentedWorker as unknown as typeof Worker
}

export function installAppDataInstrumentation(): () => void {
  const disposables = createDisposableSet()
  const originalHook = window.__simulatorHook
  const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'Worker')
  const OriginalWorker = window.Worker

  window.__simulatorHook = {
    appData: (body: unknown) => {
      const record = body as AppDataBody | null
      if (record?.bridgeId && record?.moduleId) {
        const key = `${record.bridgeId}/${record.moduleId}`
        appDataCache.set(key, record.data)
        publishSnapshot()
      }
      sendToHost(SimulatorChannel.AppData, body)
    },
  }

  Object.defineProperty(window, 'Worker', {
    configurable: true,
    writable: true,
    value: createInstrumentedWorker(OriginalWorker),
  })

  publishSnapshot()

  disposables.add(() => {
    if (originalDescriptor) {
      Object.defineProperty(window, 'Worker', originalDescriptor)
    } else {
      window.Worker = OriginalWorker
    }
  })

  disposables.add(() => {
    if (originalHook) {
      window.__simulatorHook = originalHook
    } else {
      delete window.__simulatorHook
    }
  })

  disposables.add(() => {
    appDataCache.clear()
    clearAppDataSnapshot()
    publishSnapshot()
  })

  return () => {
    disposables.disposeAll()
  }
}

export function sendAllAppData(): void {
  publishSnapshot()
  sendToHost(BridgeChannel.AppDataGetAllResponse, simulatorBridge.appdata.data)
}
