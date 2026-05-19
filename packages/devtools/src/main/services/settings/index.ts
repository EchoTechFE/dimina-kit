import { app, nativeTheme } from 'electron'
import fs from 'fs'
import path from 'path'

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
    watch: boolean
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
    port: 9222,
  },
  mcp: {
    enabled: false,
    port: 7789,
  },
  compile: {
    watch: true,
  },
  theme: 'system',
  lastCreateBaseDir: null,
}

function getSettingsFile(): string {
  return path.join(app.getPath('userData'), 'dimina-workbench-settings.json')
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
        watch: data.compile?.watch ?? DEFAULTS.compile.watch,
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
    }
  }
}

export function saveWorkbenchSettings(settings: WorkbenchSettings): void {
  fs.writeFileSync(getSettingsFile(), JSON.stringify(settings, null, 2))
}

export function applyTheme(theme: ThemeSource): void {
  nativeTheme.themeSource = theme
}
