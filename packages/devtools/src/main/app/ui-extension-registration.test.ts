/**
 * Whether a simulator UI extension registration is legal is a property of the
 * registration, not of what happens to be on screen when the host makes it.
 *
 * Hosts register in `onSetup`, before any project window exists. A bad
 * registration accepted there — malformed id, relative script path, an id
 * already taken — surfaces much later, while a project window is being built,
 * where the failure reads as "this project will not open" and, because the bad
 * record stays in the ledger, keeps every later project from opening too.
 *
 * The same isolation applies to one window refusing an otherwise legal
 * extension: that is a fact about that window, and it must not decide whether
 * the project opens.
 */
import { describe, expect, it } from 'vitest'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import type {
  SimulatorUiExtensionHandle,
  SimulatorUiExtensionRegistration,
} from '../../shared/simulator-ui.js'
import { createUiExtensionTargets, type UiExtensionWindow } from './ui-extension-targets.js'

/** A project window that takes extensions, or refuses them when told to. */
function fakeWindow(refuse?: string) {
  const taken: string[] = []
  const window: UiExtensionWindow = {
    simulatorUiExtensions: {
      register: (registration: SimulatorUiExtensionRegistration): SimulatorUiExtensionHandle => {
        if (refuse) throw new Error(refuse)
        taken.push(registration.id)
        return {
          dispose: () => {},
          invoke: async <T>(method: string) => method as T,
        }
      },
    },
    registry: { add: (d: Disposable) => d },
  }
  return { window, taken }
}

function targetsWithWindows(...windows: UiExtensionWindow[]) {
  return createUiExtensionTargets<UiExtensionWindow>({
    projectWindows: () => windows,
    activeWindow: () => windows[0] ?? null,
  })
}

describe('registering a simulator UI extension before any project window exists', () => {
  it('rejects a malformed id right away', () => {
    const targets = targetsWithWindows()
    expect(
      () => targets.register({ id: 'not a valid id', rendererScriptPath: '/tmp/panel.js' }),
      'the host has to learn its registration is unusable while it is registering, not when the user opens a project',
    ).toThrow(/id/i)
  })

  it('rejects a renderer script path that is not absolute', () => {
    const targets = targetsWithWindows()
    expect(
      () => targets.register({ id: 'host.panel', rendererScriptPath: 'panel.js' }),
      'a relative path is resolved against nothing in particular, so it can only fail later inside a window',
    ).toThrow(/absolute/i)
  })

  it('rejects a second registration of an id already taken', () => {
    const targets = targetsWithWindows()
    targets.register({ id: 'host.panel', rendererScriptPath: '/tmp/panel.js' })
    expect(
      () => targets.register({ id: 'host.panel', rendererScriptPath: '/tmp/other.js' }),
      'two extensions under one id cannot both be reachable; the second registration is the one that is wrong',
    ).toThrow(/already registered/i)
  })

  it('leaves nothing behind when it rejects one', () => {
    const targets = targetsWithWindows()
    expect(() =>
      targets.register({ id: 'bad id', rendererScriptPath: '/tmp/panel.js' }),
    ).toThrow()

    const opened = fakeWindow()
    expect(
      () => targets.attachTo(opened.window),
      'a rejected registration kept in the ledger would be handed to every project window opened afterwards',
    ).not.toThrow()
    expect(opened.taken).toEqual([])

    // The rejected id was never taken, so the host can register it properly.
    expect(() =>
      targets.register({ id: 'bad.id', rendererScriptPath: '/tmp/panel.js' }),
    ).not.toThrow()
  })

  it('frees the id it was registered under, not the one the object carries now', () => {
    const targets = targetsWithWindows()
    // The host reuses one object to describe both extensions.
    const reused: SimulatorUiExtensionRegistration = {
      id: 'host.first',
      rendererScriptPath: '/tmp/panel.js',
    }
    const first = targets.register(reused)
    reused.id = 'host.second'
    targets.register({ id: 'host.second', rendererScriptPath: '/tmp/other.js' })

    void first.dispose()

    expect(
      () => targets.register({ id: 'host.second', rendererScriptPath: '/tmp/third.js' }),
      'the second extension is still registered and reachable; accepting its id again puts two extensions under one id in every project window',
    ).toThrow(/already registered/i)
    expect(
      () => targets.register({ id: 'host.first', rendererScriptPath: '/tmp/panel.js' }),
      'the disposed registration must give its own id back, or that id stays taken for the life of the app',
    ).not.toThrow()
  })

  it('gives a window opened later the extension as it was registered', () => {
    const targets = targetsWithWindows()
    const reused: SimulatorUiExtensionRegistration = {
      id: 'host.first',
      rendererScriptPath: '/tmp/panel.js',
    }
    targets.register(reused)
    reused.id = 'host.second'
    targets.register({ id: 'host.second', rendererScriptPath: '/tmp/other.js' })

    const opened = fakeWindow()
    targets.attachTo(opened.window)

    expect(
      opened.taken,
      'the ledger describes what was registered; replaying the host object as it reads now would give the window two copies of one extension and lose the other entirely',
    ).toEqual(['host.first', 'host.second'])
  })

  it('frees the id of a registration the host disposed', () => {
    const targets = targetsWithWindows()
    const handle = targets.register({ id: 'host.panel', rendererScriptPath: '/tmp/panel.js' })
    void handle.dispose()

    expect(
      () => targets.register({ id: 'host.panel', rendererScriptPath: '/tmp/panel.js' }),
      're-registering an id the host gave up is how a host swaps its extension implementation',
    ).not.toThrow()
  })
})

describe('a project window that cannot take an extension', () => {
  it('still opens, and still takes the extensions it can', () => {
    const refusing = fakeWindow('this window already has that extension')
    const targets = createUiExtensionTargets<UiExtensionWindow>({
      projectWindows: () => [],
      activeWindow: () => null,
    })
    targets.register({ id: 'host.panel', rendererScriptPath: '/tmp/panel.js' })

    expect(
      () => targets.attachTo(refusing.window),
      'one extension failing to mount is not a reason to roll the whole project window back — the user would be left unable to open any project',
    ).not.toThrow()
  })

  it('does not stop a later project window from taking it', () => {
    const refusing = fakeWindow('this window already has that extension')
    const opened = fakeWindow()
    const windows: UiExtensionWindow[] = [refusing.window]
    const targets = createUiExtensionTargets<UiExtensionWindow>({
      projectWindows: () => windows,
      activeWindow: () => windows[0] ?? null,
    })

    expect(
      () => targets.register({ id: 'host.panel', rendererScriptPath: '/tmp/panel.js' }),
      'a window refusing the extension is a fact about that window, not about the registration',
    ).not.toThrow()

    windows.push(opened.window)
    targets.attachTo(opened.window)
    expect(
      opened.taken,
      'the next project window must still get the extension the host registered',
    ).toEqual(['host.panel'])
  })
})
