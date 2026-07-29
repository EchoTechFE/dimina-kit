import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerSimulatorUiExtension } from '../shared/simulator-ui'
import {
  attachSimulatorUiRoot,
  dispatchSimulatorChromeAction,
} from './ui-extension-runtime'

const cleanup: Array<() => void> = []

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.()
  document.body.replaceChildren()
})

describe('simulator UI renderer runtime', () => {
  it('mounts into the active root and remounts across a shell promotion', () => {
    const dispose = vi.fn()
    const mount = vi.fn(({ overlayRoot }: { overlayRoot: HTMLElement }) => {
      overlayRoot.dataset.mounted = 'yes'
      return dispose
    })
    cleanup.push(registerSimulatorUiExtension({ id: 'test.mount', mount }))

    const current = document.createElement('div')
    const pending = document.createElement('div')
    cleanup.push(attachSimulatorUiRoot(current, 'app-1'))
    expect(mount).toHaveBeenLastCalledWith(expect.objectContaining({
      overlayRoot: current,
      appId: 'app-1',
    }))

    cleanup.push(attachSimulatorUiRoot(pending, 'app-2'))
    expect(dispose).toHaveBeenCalledOnce()
    expect(mount).toHaveBeenLastCalledWith(expect.objectContaining({
      overlayRoot: pending,
      appId: 'app-2',
    }))
  })

  it('routes host invokes and semantic chrome actions without DOM selectors', async () => {
    const invoke = vi.fn(async (method: string, params: unknown) => ({ method, params }))
    const onChromeAction = vi.fn(async () => true)
    cleanup.push(registerSimulatorUiExtension({
      id: 'test.commands',
      invoke,
      onChromeAction,
    }))

    const bridge = (globalThis as typeof globalThis & {
      __diminaSimulatorUi: {
        invoke(id: string, method: string, params: unknown): Promise<unknown>
      }
    }).__diminaSimulatorUi

    await expect(bridge.invoke('test.commands', 'share', { url: 'x' })).resolves.toEqual({
      method: 'share',
      params: { url: 'x' },
    })
    await expect(dispatchSimulatorChromeAction({
      name: 'capsule.more',
      appId: 'app-1',
      appName: 'Demo',
      pagePath: 'pages/index/index',
    })).resolves.toBe(true)
    expect(onChromeAction).toHaveBeenCalledWith(expect.objectContaining({
      name: 'capsule.more',
      appId: 'app-1',
    }))
  })
})
