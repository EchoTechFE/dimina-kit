import { describe, it, expect, vi, beforeEach } from 'vitest'

const transport = vi.hoisted(() => ({
  invoke: vi.fn((_channel: string, ..._args: unknown[]) => Promise.resolve(null)),
  invokeStrict: vi.fn(),
  send: vi.fn(),
  sendSync: vi.fn(),
  on: vi.fn((_channel: string, _handler: (...args: unknown[]) => void) => () => {}),
}))

vi.mock('./ipc-transport', () => transport)

import * as appApi from './app-api'

beforeEach(() => {
  transport.invoke.mockClear()
  transport.on.mockClear()
})

describe('app-api: header avatar facade', () => {
  it("getHeaderAvatar invokes the 'app:getHeaderAvatar' wire channel", async () => {
    await appApi.getHeaderAvatar()

    expect(transport.invoke).toHaveBeenCalledWith('app:getHeaderAvatar')
  })

  it("onHeaderAvatarChanged subscribes to the 'app:headerAvatarChanged' event", () => {
    const handler = vi.fn()
    const dispose = appApi.onHeaderAvatarChanged(handler)

    expect(transport.on).toHaveBeenCalledTimes(1)
    expect(transport.on.mock.calls[0]?.[0]).toBe('app:headerAvatarChanged')
    expect(typeof dispose).toBe('function')
  })

  it("invokeHeaderAvatar invokes the 'app:invokeHeaderAvatar' wire channel", async () => {
    await appApi.invokeHeaderAvatar()

    expect(transport.invoke).toHaveBeenCalledWith('app:invokeHeaderAvatar')
  })

  it("getHeaderActions invokes the 'app:getHeaderActions' wire channel", async () => {
    await appApi.getHeaderActions()

    expect(transport.invoke).toHaveBeenCalledWith('app:getHeaderActions')
  })

  it("invokeHeaderAction invokes the 'app:invokeHeaderAction' wire channel with the action id", async () => {
    await appApi.invokeHeaderAction('upload')

    expect(transport.invoke).toHaveBeenCalledWith('app:invokeHeaderAction', 'upload')
  })

  it("onHeaderActionsChanged subscribes to the 'app:headerActionsChanged' event", () => {
    const handler = vi.fn()
    const dispose = appApi.onHeaderActionsChanged(handler)

    expect(transport.on).toHaveBeenCalledTimes(1)
    expect(transport.on.mock.calls[0]?.[0]).toBe('app:headerActionsChanged')
    expect(typeof dispose).toBe('function')
  })
})
