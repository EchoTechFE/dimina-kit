export type BridgeTarget = 'service' | 'render' | 'container'

export interface MessageEnvelope<TBody extends Record<string, unknown> = Record<string, unknown>> {
  type: string
  target: BridgeTarget
  body: TBody
}

export interface SpawnRequest {
  appId: string
  bridgeId?: string
  pagePath?: string
  scene?: number
  query?: Record<string, unknown>
}

export interface SpawnResult {
  bridgeId: string
  pagePath: string
}

export interface HostEnvSnapshot {
  brand: string
  model: string
  platform: string
  system: string
  version: string
  SDKVersion: string
  pixelRatio: number
  screenWidth: number
  screenHeight: number
  windowWidth: number
  windowHeight: number
  statusBarHeight: number
  language: string
  theme: string
}
