/**
 * TDD failing tests for the (not-yet-implemented) pure adapter
 * `toWorkbenchAppConfig(config)`.
 *
 * The adapter bridges the two distinct config shapes:
 *  - INPUT:  `WorkbenchConfig` exported by `@dimina-kit/workbench`
 *            (`packages/workbench/src/types.ts`)
 *  - OUTPUT: `WorkbenchAppConfig` consumed by dimina-devtools' own
 *            `createWorkbenchApp(config)` (`packages/devtools/src/shared/types.ts`)
 *
 * It returns `{ appConfig, deferred }`:
 *  - `appConfig`  — the directly-mappable, declarative fields.
 *  - `deferred`   — the cross-process / runtime contributions
 *                   (toolbar/windows/events/hostServices/simulatorApis/menu/
 *                   lifecycle/setup) that U4/U6 wire up separately and which
 *                   must NOT leak into `appConfig` top-level mappable fields.
 *
 * Pure function — must not touch electron. We use ONLY type-only imports for
 * the config shapes and construct structural stubs (plain objects/functions)
 * for runtime contributions, so importing this test never pulls electron in.
 */
import { describe, it, expect, vi } from 'vitest'

import type { WorkbenchConfig } from '@dimina-kit/workbench'

import { toWorkbenchAppConfig } from './workbench-config-adapter.js'

// ── structural stubs (no electron, no value imports from workbench) ────────

/** Minimal structural HostEvent — adapter only re-homes the array reference. */
function fakeEvent(name: string) {
  return {
    name,
    publish: () => {},
    on: () => ({ dispose: () => {} }),
  }
}

describe('toWorkbenchAppConfig — directly-mappable app fields', () => {
  it('maps config.app.name → appConfig.appName', () => {
    const { appConfig } = toWorkbenchAppConfig({ app: { name: 'QDMP DevTools' } })
    expect(appConfig.appName).toBe('QDMP DevTools')
  })

  it('maps config.app.headerHeight → appConfig.headerHeight', () => {
    const { appConfig } = toWorkbenchAppConfig({ app: { headerHeight: 72 } })
    expect(appConfig.headerHeight).toBe(72)
  })

  it('maps config.app.icon → appConfig.icon', () => {
    const { appConfig } = toWorkbenchAppConfig({ app: { icon: '/abs/icon.png' } })
    expect(appConfig.icon).toBe('/abs/icon.png')
  })

  it('passes through config.app.window {width,height,minWidth,minHeight} to appConfig.window', () => {
    const window = { width: 1280, height: 800, minWidth: 640, minHeight: 480 }
    const { appConfig } = toWorkbenchAppConfig({ app: { window } })
    expect(appConfig.window).toEqual(window)
  })

  it('maps config.app.adapter → appConfig.adapter (same reference)', () => {
    const adapter = {
      openProject: async () => ({ close: async () => {}, port: 0, appInfo: {} }),
    } as unknown as NonNullable<WorkbenchConfig['app']>['adapter']
    const { appConfig } = toWorkbenchAppConfig({ app: { adapter } })
    expect(appConfig.adapter).toBe(adapter)
  })
})

describe('toWorkbenchAppConfig — projects & templates', () => {
  it('maps config.projects → appConfig.projectsProvider (same reference)', () => {
    const projects = {
      listProjects: () => [],
      addProject: () => ({}),
      removeProject: () => {},
    } as unknown as WorkbenchConfig['projects']
    const { appConfig } = toWorkbenchAppConfig({ projects })
    expect(appConfig.projectsProvider).toBe(projects)
  })

  it('maps config.templates.custom → appConfig.projectTemplates', () => {
    const custom = [{ id: 't1', name: 'Template One' }]
    const { appConfig } = toWorkbenchAppConfig({ templates: { custom } })
    expect(appConfig.projectTemplates).toEqual(custom)
  })

  it('maps config.templates.builtins → appConfig.builtinTemplates', () => {
    const { appConfig } = toWorkbenchAppConfig({ templates: { builtins: 'all' } })
    expect(appConfig.builtinTemplates).toBe('all')
  })

  it('supports the builtins allowlist form', () => {
    const { appConfig } = toWorkbenchAppConfig({
      templates: { builtins: ['empty', 'tabbar'] },
    })
    expect(appConfig.builtinTemplates).toEqual(['empty', 'tabbar'])
  })
})

describe('toWorkbenchAppConfig — update contribution', () => {
  /**
   * INPUT `UpdateContribution` (workbench/src/types.ts:134) carries BOTH the
   * checker methods (`checkForUpdates` / `downloadUpdate`) AND option fields
   * (`checkInterval` / `initialDelay` / `getCurrentVersion`) in one object.
   *
   * OUTPUT splits them: `appConfig.updateChecker` is the `UpdateChecker`
   * (shared/types.ts:104 — just the two methods) and the option fields land in
   * `appConfig.updateOptions` (shared/types.ts:208).
   */
  it('routes the checker methods into appConfig.updateChecker', () => {
    const checkForUpdates = async () => null
    const downloadUpdate = async () => '/tmp/pkg.zip'
    const { appConfig } = toWorkbenchAppConfig({
      update: { checkForUpdates, downloadUpdate },
    })
    expect(appConfig.updateChecker).toBeDefined()
    expect(appConfig.updateChecker!.checkForUpdates).toBe(checkForUpdates)
    expect(appConfig.updateChecker!.downloadUpdate).toBe(downloadUpdate)
  })

  it('routes checkInterval / initialDelay / getCurrentVersion into appConfig.updateOptions', () => {
    const getCurrentVersion = () => '9.9.9'
    const { appConfig } = toWorkbenchAppConfig({
      update: {
        checkForUpdates: async () => null,
        downloadUpdate: async () => '',
        checkInterval: 3600_000,
        initialDelay: 5000,
        getCurrentVersion,
      },
    })
    expect(appConfig.updateOptions).toEqual({
      checkInterval: 3600_000,
      initialDelay: 5000,
      getCurrentVersion,
    })
  })

  it('does not leak option fields onto appConfig.updateChecker', () => {
    const { appConfig } = toWorkbenchAppConfig({
      update: {
        checkForUpdates: async () => null,
        downloadUpdate: async () => '',
        checkInterval: 1234,
      },
    })
    expect((appConfig.updateChecker as unknown as Record<string, unknown>).checkInterval).toBeUndefined()
  })
})

describe('toWorkbenchAppConfig — deferred (cross-process / runtime) contributions', () => {
  /**
   * toolbar / windows / events / hostServices / simulatorApis / menu /
   * lifecycle / setup are NOT directly mappable to declarative
   * `WorkbenchAppConfig` fields — they must surface in `deferred` and must NOT
   * appear in appConfig.
   */
  const full: WorkbenchConfig = {
    app: { name: 'Host' },
    toolbar: {
      source: { url: 'http://localhost/toolbar.html' },
      preloadPath: '/abs/toolbar-preload.js',
      height: 48,
    },
    windows: {
      settings: { source: { file: './settings.html' }, width: 400, height: 300 },
    },
    events: [fakeEvent('authChanged')] as unknown as WorkbenchConfig['events'],
    hostServices: { getUser: async () => null } as unknown as WorkbenchConfig['hostServices'],
    simulatorApis: { login: async () => null } as unknown as WorkbenchConfig['simulatorApis'],
    menu: { build: () => {} },
    lifecycle: { beforeClose: async () => {}, timeoutMs: 10_000 },
    setup: async () => {},
  }

  it('surfaces toolbar in deferred', () => {
    const { deferred } = toWorkbenchAppConfig(full)
    expect(deferred.toolbar).toBe(full.toolbar)
  })

  it('surfaces windows in deferred', () => {
    const { deferred } = toWorkbenchAppConfig(full)
    expect(deferred.windows).toBe(full.windows)
  })

  it('surfaces events in deferred', () => {
    const { deferred } = toWorkbenchAppConfig(full)
    expect(deferred.events).toBe(full.events)
  })

  it('surfaces hostServices in deferred', () => {
    const { deferred } = toWorkbenchAppConfig(full)
    expect(deferred.hostServices).toBe(full.hostServices)
  })

  it('surfaces simulatorApis in deferred', () => {
    const { deferred } = toWorkbenchAppConfig(full)
    expect(deferred.simulatorApis).toBe(full.simulatorApis)
  })

  it('surfaces menu in deferred', () => {
    const { deferred } = toWorkbenchAppConfig(full)
    expect(deferred.menu).toBe(full.menu)
  })

  it('maps lifecycle.beforeClose onto appConfig.onBeforeClose (not deferred)', async () => {
    const beforeClose = vi.fn(async () => {})
    const { appConfig, deferred } = toWorkbenchAppConfig({ lifecycle: { beforeClose } })
    expect((deferred as Record<string, unknown>).lifecycle).toBeUndefined()
    expect(typeof appConfig.onBeforeClose).toBe('function')
    await appConfig.onBeforeClose!({} as never)
    expect(beforeClose).toHaveBeenCalledTimes(1)
  })

  it('surfaces setup in deferred', () => {
    const { deferred } = toWorkbenchAppConfig(full)
    expect(deferred.setup).toBe(full.setup)
  })

  it('does NOT leak deferred contributions into appConfig', () => {
    const { appConfig } = toWorkbenchAppConfig(full)
    const leaked = appConfig as unknown as Record<string, unknown>
    // none of the deferred keys should appear as appConfig top-level fields
    expect(leaked.toolbar).toBeUndefined()
    expect(leaked.windows).toBeUndefined()
    expect(leaked.events).toBeUndefined()
    expect(leaked.hostServices).toBeUndefined()
    expect(leaked.simulatorApis).toBeUndefined()
    expect(leaked.menu).toBeUndefined()
    expect(leaked.lifecycle).toBeUndefined()
    expect(leaked.setup).toBeUndefined()
  })
})

describe('toWorkbenchAppConfig — empty / sparse config', () => {
  it('does not throw on an empty config', () => {
    expect(() => toWorkbenchAppConfig({})).not.toThrow()
  })

  it('leaves every deferred slot undefined for an empty config', () => {
    const { deferred } = toWorkbenchAppConfig({})
    expect(deferred.toolbar).toBeUndefined()
    expect(deferred.windows).toBeUndefined()
    expect(deferred.events).toBeUndefined()
    expect(deferred.hostServices).toBeUndefined()
    expect(deferred.simulatorApis).toBeUndefined()
    expect(deferred.menu).toBeUndefined()
    expect(deferred.setup).toBeUndefined()
  })

  it('emits no undefined noise fields that downstream defaulting could misread', () => {
    const { appConfig } = toWorkbenchAppConfig({})
    // An empty config must not produce own-keys whose value is undefined:
    // downstream `createWorkbenchApp` uses presence/?? defaulting, so an
    // explicit `appName: undefined` own-key would be noise.
    for (const [key, value] of Object.entries(appConfig)) {
      expect(value, `appConfig.${key} should not be an undefined own-key`).not.toBeUndefined()
    }
  })

  it('leaves appConfig.appName undefined when config.app is omitted (downstream supplies the default)', () => {
    // The adapter must NOT hard-code 'Dimina DevTools'; appName stays undefined
    // so createWorkbenchApp's own default applies.
    const { appConfig } = toWorkbenchAppConfig({})
    expect(appConfig.appName).toBeUndefined()
  })

  it('leaves appName undefined even when config.app exists but has no name', () => {
    const { appConfig } = toWorkbenchAppConfig({ app: { headerHeight: 40 } })
    expect(appConfig.appName).toBeUndefined()
  })
})
