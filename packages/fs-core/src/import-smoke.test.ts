import { describe, expect, it } from 'vitest'

/** Guards that none of the four public entry points touch a browser-only
 * global (navigator.storage, Worker, showDirectoryPicker, ...) merely by
 * being imported — those APIs are only allowed to be touched when their
 * exported functions/classes are actually invoked. This suite runs under
 * plain Node with no jsdom globals, so any import-time access would throw. */
describe('public entry points import cleanly under plain Node', () => {
  it('imports client.js and exposes the ProjectFsClient class with its static/instance API', async () => {
    const mod = await import('./client.js')
    expect(typeof mod.ProjectFsClient).toBe('function')
    expect(typeof mod.ProjectFsClient.connect).toBe('function')
    expect(typeof mod.ProjectFsClient.wipe).toBe('function')
    expect(typeof mod.ProjectFsClient.prototype.write).toBe('function')
    expect(typeof mod.ProjectFsClient.prototype.read).toBe('function')
  })

  it('imports agent-tools.js and exposes createAgentTools as a function', async () => {
    const mod = await import('./agent-tools.js')
    expect(typeof mod.createAgentTools).toBe('function')
  })

  it('imports disk-mirror.js and exposes createDiskMirror as a function', async () => {
    const mod = await import('./disk-mirror.js')
    expect(typeof mod.createDiskMirror).toBe('function')
  })

  it('imports zip.js and exposes makeZip as a function', async () => {
    const mod = await import('./zip.js')
    expect(typeof mod.makeZip).toBe('function')
  })

  it('does not touch navigator.storage, Worker, or showDirectoryPicker in this Node environment', () => {
    // Node itself defines a minimal `navigator` global (userAgent info only);
    // it has no `storage` property, unlike a real browser's OPFS-capable one.
    expect((globalThis.navigator as { storage?: unknown } | undefined)?.storage).toBeUndefined()
    expect(typeof (globalThis as { Worker?: unknown }).Worker).toBe('undefined')
    expect(typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker).toBe('undefined')
  })
})
