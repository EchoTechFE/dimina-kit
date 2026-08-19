/**
 * Electron IPC channels the main process uses to talk to a service-host window directly, bypassing the mini-app message bus.
 *
 * `HostEnvUpdate` patches the spawn context's `hostEnvSnapshot` — the object the synchronous host APIs (`wx.getSystemInfoSync`, `wx.getWindowInfo`, …) read on every call.
 * It is the ONLY way those APIs learn about new geometry: the framework-level `hostEnvUpdate` bus message feeds dimina's own host-env store instead, so a writer that needs both must send both.
 */
export const SERVICE_HOST_CHANNELS = {
  HostEnvUpdate: 'service-host:host-env:update',
} as const
