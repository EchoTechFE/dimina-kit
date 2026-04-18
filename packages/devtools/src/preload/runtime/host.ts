import { ipcRenderer } from 'electron'

export function sendToHost(channel: string, data: unknown): void {
  ipcRenderer.sendToHost(channel, data)
}

export function safeSerialize(val: unknown): unknown {
  if (val === null || val === undefined) return val
  if (typeof val === 'function') return `[Function: ${(val as { name?: string }).name || 'anonymous'}]`
  if (typeof val !== 'object') return val
  if (val instanceof Error) return { __isError: true, message: val.message, stack: val.stack }
  try {
    return structuredClone(val)
  } catch {
    // expected: some objects (e.g. DOM nodes, proxies) cannot be structuredCloned
  }
  try {
    return JSON.parse(JSON.stringify(val))
  } catch {
    // expected: circular references or non-serializable values
  }
  return String(val)
}
