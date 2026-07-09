import { app, nativeTheme } from 'electron'
import fs from 'fs'
import path from 'path'
import { DEFAULT_CDP_PORT } from '../../../shared/constants.js'

export type ThemeSource = 'system' | 'dark' | 'light'

export interface WorkbenchSettings {
  cdp: {
    enabled: boolean
    port: number
  }
  mcp: {
    enabled: boolean
    port: number
  }
  compile: {
    /** Watch project files and auto-recompile on change. */
    autoBuild: boolean
  }
  preview: {
    /** Reload the simulator once a watcher-triggered rebuild lands. Independent
     * of `compile.autoBuild`: "auto-compile on save, reload manually" is valid
     * and preserves the running page stack / form state across a save. */
    autoReload: boolean
  }
  theme: ThemeSource
  /**
   * Parent directory used to pre-fill the "新建项目" dialog's target path.
   * Updated whenever a project is successfully created. `null` until the
   * first create; the dialog then falls back to a platform default
   * (Documents).
   */
  lastCreateBaseDir: string | null
}

const DEFAULTS: WorkbenchSettings = {
  cdp: {
    enabled: false,
    port: DEFAULT_CDP_PORT,
  },
  mcp: {
    enabled: false,
    port: 7789,
  },
  compile: {
    autoBuild: true,
  },
  preview: {
    autoReload: true,
  },
  theme: 'system',
  lastCreateBaseDir: null,
}

function getSettingsFile(): string {
  return path.join(app.getPath('userData'), 'dimina-workbench-settings.json')
}

/** Accept `value` only when it is a real boolean, else `fallback`. A bare `??`
 * chain guards only null/undefined, so a hand-edited or corrupt config with a
 * stringy `"false"` would pass through and read as truthy downstream — silently
 * keeping a toggle ON when the user meant OFF. */
function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function loadWorkbenchSettings(): WorkbenchSettings {
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsFile(), 'utf-8'))
    const theme = (['system', 'dark', 'light'] as ThemeSource[]).includes(data.theme)
      ? (data.theme as ThemeSource)
      : DEFAULTS.theme
    return {
      cdp: {
        enabled: data.cdp?.enabled ?? DEFAULTS.cdp.enabled,
        port: data.cdp?.port ?? DEFAULTS.cdp.port,
      },
      mcp: {
        enabled: data.mcp?.enabled ?? DEFAULTS.mcp.enabled,
        port: data.mcp?.port ?? DEFAULTS.mcp.port,
      },
      compile: {
        // Legacy files persisted a single `compile.watch`; the new schema
        // splits it into `compile.autoBuild` (recompile on save) and
        // `preview.autoReload` (reload the simulator afterwards). Prefer the new
        // key, fall back to the legacy one so an old settings file keeps its
        // "auto-compile" choice; `preview.autoReload` defaults to true (the old
        // always-reload behavior) when the file predates the split.
        autoBuild: pickBool(data.compile?.autoBuild, pickBool(data.compile?.watch, DEFAULTS.compile.autoBuild)),
      },
      preview: {
        autoReload: pickBool(data.preview?.autoReload, DEFAULTS.preview.autoReload),
      },
      theme,
      lastCreateBaseDir:
        typeof data.lastCreateBaseDir === 'string'
          ? data.lastCreateBaseDir
          : DEFAULTS.lastCreateBaseDir,
    }
  } catch {
    return {
      ...DEFAULTS,
      cdp: { ...DEFAULTS.cdp },
      mcp: { ...DEFAULTS.mcp },
      compile: { ...DEFAULTS.compile },
      preview: { ...DEFAULTS.preview },
    }
  }
}

export function saveWorkbenchSettings(settings: WorkbenchSettings): void {
  fs.writeFileSync(getSettingsFile(), JSON.stringify(settings, null, 2))
}

export function applyTheme(theme: ThemeSource): void {
  nativeTheme.themeSource = theme
}
