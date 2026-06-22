/**
 * Renderer wrapper for opening the embedded settings overlay.
 *
 * CONTRACT (public API on settings-api.ts):
 *
 *   export function setSettingsVisible(visible: boolean): Promise<void>
 *
 * It must drive the 'settings:setVisible' wire channel
 * (SettingsChannel.SetVisible — registered in src/main/ipc/settings.ts,
 * pinned as a survivor in dead-channels-decommission.test.ts) via the
 * ipc-transport invoke path, passing the boolean through.
 *
 * Real bug this catches: a settings button wired to a wrapper that hits the
 * WRONG wire name — e.g. the decommissioned 'workbenchSettings:setVisible' —
 * silently opens nothing. The component test asserts the button calls the
 * wrapper; THIS test pins the wrapper to the wire, closing the chain
 * button → wrapper → 'settings:setVisible'.
 *
 * The export is reached via the module namespace (not a direct named import).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const transport = vi.hoisted(() => ({
  // Record both invoke flavors — the contract is "an invoke-style round trip
  // on the right channel", not which lenient/strict helper carries it. The
  // explicit rest signature makes mock.calls carry the (channel, ...args)
  // tuples the assertions below read.
  invoke: vi.fn((_channel: string, ..._args: unknown[]) => Promise.resolve(undefined)),
  invokeStrict: vi.fn((_channel: string, ..._args: unknown[]) => Promise.resolve(undefined)),
  send: vi.fn(),
  sendSync: vi.fn(),
  on: vi.fn(() => () => {}),
}))

vi.mock('./ipc-transport', () => transport)

import * as settingsApi from './settings-api'

type InvokeCall = [channel: string, ...args: unknown[]]

function allInvokeCalls(): InvokeCall[] {
  return [
    ...(transport.invoke.mock.calls as unknown as InvokeCall[]),
    ...(transport.invokeStrict.mock.calls as unknown as InvokeCall[]),
  ]
}

beforeEach(() => {
  transport.invoke.mockClear()
  transport.invokeStrict.mockClear()
  transport.send.mockClear()
})

describe("settings-api: setSettingsVisible drives 'settings:setVisible'", () => {
  it('exports a setSettingsVisible function', () => {
    expect(
      typeof (settingsApi as Record<string, unknown>).setSettingsVisible,
      'settings-api.ts must grow the renderer wrapper — without it the settings button has no sanctioned way onto the wire (ipc-transport is the only allowed touchpoint)',
    ).toBe('function')
  })

  it("setSettingsVisible(true) invokes the 'settings:setVisible' wire channel with true", async () => {
    const fn = (settingsApi as Record<string, unknown>).setSettingsVisible as
      | ((visible: boolean) => Promise<void>)
      | undefined
    expect(typeof fn).toBe('function')

    await fn!(true)

    const calls = allInvokeCalls().filter(([channel]) => channel === 'settings:setVisible')
    expect(
      calls.length,
      "must invoke 'settings:setVisible' (the embedded overlay channel) — NOT the Wave-1-decommissioned 'workbenchSettings:setVisible' and NOT a fire-and-forget send the caller cannot await",
    ).toBeGreaterThanOrEqual(1)
    expect(
      calls[0],
      'the boolean must pass through — the main handler branches on it (true=show+init, false=hide)',
    ).toEqual(['settings:setVisible', true])
  })

  it('setSettingsVisible(false) passes false through (close path stays expressible)', async () => {
    const fn = (settingsApi as Record<string, unknown>).setSettingsVisible as
      | ((visible: boolean) => Promise<void>)
      | undefined
    expect(typeof fn).toBe('function')

    await fn!(false)

    const calls = allInvokeCalls().filter(([channel]) => channel === 'settings:setVisible')
    expect(calls[0]).toEqual(['settings:setVisible', false])
  })
})
