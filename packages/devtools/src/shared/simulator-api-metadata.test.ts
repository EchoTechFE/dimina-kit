/**
 * Contract for the subscription-class ("persistent") simulator-API registry.
 *
 * Bug being pinned (TDD red): under native-host, the dimina submodule strips the
 * service-side `keep: true` flag off subscription APIs before the params reach
 * the container. By the time `audioListen` is forwarded, `keep` is gone, so the
 * runtime can no longer tell a one-shot API from a persistent subscription by
 * looking at params. The fix is to recognise persistent APIs BY NAME, via a
 * single shared metadata module both `run-api-async` (simulator side) and
 * `bridge-router` (main side) consult.
 *
 * This module does not exist yet — the import below is the red. The contract:
 *   - `PERSISTENT_SIMULATOR_APIS` is a Set of the subscription-class API names.
 *     Today the only such API is `audioListen` (it carries the 9 audio DOM
 *     events canplay/play/timeupdate/ended/…).
 *   - `isPersistentSimulatorApi(name)` is true for those names, false for any
 *     ordinary one-shot API (request, getSystemInfoSync, …) and for junk.
 *
 * These assertions describe observable membership only; they do not restate the
 * implementation (a Set literal could satisfy them many ways).
 */
import { describe, it, expect } from 'vitest'
import {
  PERSISTENT_SIMULATOR_APIS,
  isPersistentSimulatorApi,
} from './simulator-api-metadata'

describe('persistent simulator-API metadata', () => {
  it('classifies audioListen as a persistent (subscription-class) API', () => {
    expect(isPersistentSimulatorApi('audioListen')).toBe(true)
  })

  it('classifies ordinary one-shot APIs as NOT persistent', () => {
    // Representative one-shot APIs: a network call, a sync getter, a chooser.
    // None of these stay subscribed; each settles exactly once.
    expect(isPersistentSimulatorApi('getSystemInfoSync')).toBe(false)
    expect(isPersistentSimulatorApi('request')).toBe(false)
    expect(isPersistentSimulatorApi('chooseImage')).toBe(false)
  })

  it('returns false for unknown / junk names rather than throwing', () => {
    expect(isPersistentSimulatorApi('')).toBe(false)
    expect(isPersistentSimulatorApi('definitely-not-an-api')).toBe(false)
  })

  it('exposes the persistent names as an iterable membership set including audioListen', () => {
    // Consumers (run-api-async, bridge-router) read membership; assert the Set
    // is a real Set whose membership agrees with the predicate.
    expect(PERSISTENT_SIMULATOR_APIS).toBeInstanceOf(Set)
    expect(PERSISTENT_SIMULATOR_APIS.has('audioListen')).toBe(true)
    for (const name of PERSISTENT_SIMULATOR_APIS) {
      expect(isPersistentSimulatorApi(name)).toBe(true)
    }
  })
})
