import { act, renderHook } from '@testing-library/react'
import type { RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  attachNativeSimulatorMock,
  captureThumbnailMock,
  currentPageListeners,
} = vi.hoisted(() => ({
  attachNativeSimulatorMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  captureThumbnailMock: vi.fn(async (..._args: unknown[]) => null),
  currentPageListeners: [] as Array<(pagePath: string) => void>,
}))

vi.mock('@/shared/api', () => ({
  attachNativeSimulator: attachNativeSimulatorMock,
  captureThumbnail: captureThumbnailMock,
  onSimulatorCurrentPage: vi.fn((handler: (pagePath: string) => void) => {
    currentPageListeners.push(handler)
    return () => {
      const index = currentPageListeners.indexOf(handler)
      if (index >= 0) currentPageListeners.splice(index, 1)
    }
  }),
}))

import { DEVICES } from '@/shared/constants'
import type { DeviceType } from './use-project-runtime-controller'
import { useSimulator } from './use-simulator'
import type { UseSimulatorProps } from './use-simulator'

const PROJECT_PATH = '/workspace/thumbnail-project'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeProps(): UseSimulatorProps & { projectPath: string } {
  return {
    compileStatus: { status: 'ready', message: '编译完成' },
    sendDeviceInfo: vi.fn(),
    simPanelWidthRef: { current: 420 } as RefObject<number>,
    deviceRef: { current: DEVICES[1] as DeviceType } as RefObject<DeviceType>,
    appInfo: { appId: 'thumbnail-app' },
    compileConfig: {
      startPage: 'pages/index/index',
      scene: 1001,
      queryParams: [],
    },
    port: 7788,
    hotReloadToken: 0,
    relaunchNonce: 0,
    projectPath: PROJECT_PATH,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  attachNativeSimulatorMock.mockClear()
  captureThumbnailMock.mockClear()
  currentPageListeners.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useSimulator: native-host project thumbnail capture', () => {
  it('does not start the capture delay while attach has returned to IPC but the native page is not ready', async () => {
    const props = makeProps()
    const ready = deferred<void>()
    attachNativeSimulatorMock.mockReturnValueOnce(ready.promise)

    renderHook(() => useSimulator(props as UseSimulatorProps))

    expect(attachNativeSimulatorMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(captureThumbnailMock).not.toHaveBeenCalled()
  })

  it('debounces capture for three seconds after the native first page becomes ready', async () => {
    const props = makeProps()
    const ready = deferred<void>()
    attachNativeSimulatorMock.mockReturnValueOnce(ready.promise)

    renderHook(() => useSimulator(props as UseSimulatorProps))

    await act(async () => {
      ready.resolve()
      await ready.promise
      await vi.advanceTimersByTimeAsync(2_999)
    })
    expect(captureThumbnailMock).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(captureThumbnailMock).toHaveBeenCalledTimes(1)
    expect(captureThumbnailMock).toHaveBeenCalledWith(PROJECT_PATH)
  })

  it('cancels capture when unmounted before native readiness', async () => {
    const props = makeProps()
    const ready = deferred<void>()
    attachNativeSimulatorMock.mockReturnValueOnce(ready.promise)
    const { unmount } = renderHook(() =>
      useSimulator(props as UseSimulatorProps),
    )

    unmount()

    await act(async () => {
      ready.resolve()
      await ready.promise
      await vi.advanceTimersByTimeAsync(3_000)
    })

    expect(captureThumbnailMock).not.toHaveBeenCalled()
  })

  it('cancels the old project capture when switching projects', async () => {
    const projectAReady = deferred<void>()
    const projectBReady = deferred<void>()
    attachNativeSimulatorMock
      .mockReturnValueOnce(projectAReady.promise)
      .mockReturnValueOnce(projectBReady.promise)
    const propsA = makeProps()
    const propsB = {
      ...propsA,
      projectPath: '/workspace/project-b',
      appInfo: { appId: 'thumbnail-app-b' },
    }
    const { rerender } = renderHook(
      ({ props }) => useSimulator(props as UseSimulatorProps),
      { initialProps: { props: propsA } },
    )

    rerender({ props: propsB })
    await act(async () => {
      projectAReady.resolve()
      await projectAReady.promise
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(captureThumbnailMock).not.toHaveBeenCalled()

    await act(async () => {
      projectBReady.resolve()
      await projectBReady.promise
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(captureThumbnailMock).toHaveBeenCalledOnce()
    expect(captureThumbnailMock).toHaveBeenCalledWith('/workspace/project-b')
  })
})
