// Test-only preload for the e2e host window. A small number of specs (e.g.
// native-host.spec.ts) drive bridge-router's raw `dmb:*` IPC channels
// directly from a renderer, the same way a real embedding host's own
// renderer would call ipcRenderer — this just exposes that passthrough.
// Never shipped as part of the published package (lives under e2e/ only).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__diminaTestIpc', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
})
