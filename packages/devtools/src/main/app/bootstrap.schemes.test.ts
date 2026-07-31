/**
 * Privileged custom scheme registration contract for render-host navigation.
 *
 * pageFrame navigates on `dmb-resource://`; without privileged `standard` and
 * `supportFetchAPI` on that scheme, ES module import/fetch of
 * `/__sdk__/native-host/*.js` fails with "Failed to fetch" and the page stays
 * empty. `difile` keeps `bypassCSP` for simulator temp-file URLs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stubs = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    commandLine: { getSwitchValue: vi.fn(() => '') },
  },
  protocol: {
    registerSchemesAsPrivileged: stubs.registerSchemesAsPrivileged,
  },
  default: {},
}))

type SchemeRegistration = {
  scheme: string
  privileges: Record<string, unknown>
}

let registerDifileScheme: typeof import('./bootstrap.js').registerDifileScheme

function schemesFromLastCall(): SchemeRegistration[] {
  const call = stubs.registerSchemesAsPrivileged.mock.calls.at(-1)
  expect(call).toBeDefined()
  return call![0] as SchemeRegistration[]
}

function findScheme(name: string): SchemeRegistration | undefined {
  return schemesFromLastCall().find((entry) => entry.scheme === name)
}

beforeEach(async () => {
  vi.resetModules()
  stubs.registerSchemesAsPrivileged.mockClear()
  ;({ registerDifileScheme } = await import('./bootstrap.js'))
})

describe('registerDifileScheme privileged scheme registration', () => {
  it('calls protocol.registerSchemesAsPrivileged exactly once across repeated calls', () => {
    registerDifileScheme()
    registerDifileScheme()
    expect(stubs.registerSchemesAsPrivileged).toHaveBeenCalledTimes(1)
  })

  it('registers difile with fetch and CSP privileges for simulator temp-file URLs', () => {
    registerDifileScheme()
    const difile = findScheme('difile')
    expect(difile).toBeDefined()
    expect(difile!.privileges).toEqual(expect.objectContaining({
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
    }))
  })

  it('registers dmb-resource with fetch privileges for render-host pageFrame ES modules', () => {
    registerDifileScheme()
    const dmbResource = findScheme('dmb-resource')
    expect(dmbResource).toBeDefined()
    expect(dmbResource!.privileges).toEqual(expect.objectContaining({
      standard: true,
      secure: true,
      supportFetchAPI: true,
    }))
  })
})
