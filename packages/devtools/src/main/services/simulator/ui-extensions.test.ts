import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createSimulatorUiExtensionRegistry } from './ui-extensions'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

class FakeWebContents extends EventEmitter {
  readonly id = 41
  readonly executed: string[] = []
  destroyed = false

  isDestroyed(): boolean {
    return this.destroyed
  }

  async executeJavaScript(source: string): Promise<unknown> {
    this.executed.push(source)
    if (source.includes('Boolean(globalThis.__diminaSimulatorUi?.has')) return true
    if (source.includes('.invoke(')) return { errMsg: 'share:ok' }
    return undefined
  }
}

function asWebContents(fake: FakeWebContents): WebContents {
  return fake as unknown as WebContents
}

describe('simulator UI extension registry', () => {
  it('installs after the simulator document loads and routes invoke through the runtime', async () => {
    const loadSource = vi.fn(async () => 'globalThis.__testExtensionLoaded = true')
    const registry = createSimulatorUiExtensionRegistry({ loadSource })
    const fake = new FakeWebContents()
    const handle = registry.register({
      id: 'host.native-mocks',
      rendererScriptPath: '/host/dist/native-mocks.js',
    })

    registry.attach(asWebContents(fake))
    expect(fake.executed).toHaveLength(0)

    fake.emit('did-finish-load')
    await vi.waitFor(() => {
      expect(fake.executed.some(source => source.includes('__testExtensionLoaded'))).toBe(true)
    })

    await expect(handle.invoke('share', { url: 'https://example.test' })).resolves.toEqual({
      errMsg: 'share:ok',
    })
    expect(loadSource).toHaveBeenCalledOnce()
    expect(fake.executed.at(-1)).toContain(
      'globalThis.__diminaSimulatorUi.invoke("host.native-mocks","share"',
    )
  })

  it('rejects invoke until the attached simulator document is ready', async () => {
    const registry = createSimulatorUiExtensionRegistry({
      loadSource: async () => 'void 0',
    })
    const fake = new FakeWebContents()
    const handle = registry.register({
      id: 'host.not-ready',
      rendererScriptPath: '/host/dist/not-ready.js',
    })
    registry.attach(asWebContents(fake))

    await expect(handle.invoke('open')).rejects.toThrow('is not ready')
    expect(fake.executed).toHaveLength(0)
  })

  it('unregisters only its own renderer extension when disposed', async () => {
    const registry = createSimulatorUiExtensionRegistry({
      loadSource: async () => 'void 0',
    })
    const fake = new FakeWebContents()
    const handle = registry.register({
      id: 'host.overlay',
      rendererScriptPath: '/host/dist/overlay.js',
    })
    registry.attach(asWebContents(fake))
    fake.emit('did-finish-load')
    await vi.waitFor(() => expect(fake.executed.length).toBeGreaterThan(1))

    handle.dispose()

    await vi.waitFor(() => {
      expect(fake.executed.at(-1)).toContain(
        'globalThis.__diminaSimulatorUi?.unregister("host.overlay")',
      )
    })
    await expect(handle.invoke('anything')).rejects.toThrow('is disposed')
  })

  it('does not install an extension disposed while its renderer source is loading', async () => {
    const source = deferred<string>()
    const loadSource = vi.fn(() => source.promise)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const registry = createSimulatorUiExtensionRegistry({
      loadSource,
    })
    const fake = new FakeWebContents()
    const handle = registry.register({
      id: 'host.slow-overlay',
      rendererScriptPath: '/host/dist/slow-overlay.js',
    })
    registry.attach(asWebContents(fake))
    fake.emit('did-finish-load')
    await vi.waitFor(() => expect(loadSource).toHaveBeenCalledOnce())

    handle.dispose()
    source.resolve('globalThis.__lateExtensionLoaded = true')

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled()
    })
    expect(fake.executed.some(script => script.includes('__lateExtensionLoaded'))).toBe(false)
    warn.mockRestore()
  })

  it('reloads renderer source for each simulator document generation', async () => {
    const loadSource = vi.fn()
      .mockResolvedValueOnce('globalThis.__extensionVersion = 1')
      .mockResolvedValueOnce('globalThis.__extensionVersion = 2')
    const registry = createSimulatorUiExtensionRegistry({ loadSource })
    const fake = new FakeWebContents()
    registry.register({
      id: 'host.watched-overlay',
      rendererScriptPath: '/host/dist/watched-overlay.js',
    })
    registry.attach(asWebContents(fake))

    fake.emit('did-finish-load')
    await vi.waitFor(() => {
      expect(fake.executed.some(script => script.includes('__extensionVersion = 1'))).toBe(true)
    })

    fake.emit('did-finish-load')
    await vi.waitFor(() => {
      expect(fake.executed.some(script => script.includes('__extensionVersion = 2'))).toBe(true)
    })
    expect(loadSource).toHaveBeenCalledTimes(2)
  })

  it('rejects ambiguous ids, duplicate ids, and relative script paths', () => {
    const registry = createSimulatorUiExtensionRegistry({
      loadSource: async () => 'void 0',
    })
    expect(() => registry.register({
      id: 'bad id',
      rendererScriptPath: '/host/bad.js',
    })).toThrow('Invalid simulator UI extension id')
    expect(() => registry.register({
      id: 'valid',
      rendererScriptPath: 'relative.js',
    })).toThrow('must be absolute')

    registry.register({ id: 'valid', rendererScriptPath: '/host/one.js' })
    expect(() => registry.register({
      id: 'valid',
      rendererScriptPath: '/host/two.js',
    })).toThrow('already registered')
  })
})
