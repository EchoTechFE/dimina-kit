import React, { useEffect, useState } from 'react'
import { DEFAULT_CDP_PORT } from '../../../shared/constants'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Switch } from '@/shared/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import {
  getCdpStatus,
  getMcpStatus,
  getWorkbenchSettings,
  onWorkbenchSettingsInit,
  restartWorkbench,
  saveWorkbenchSettings,
  setWorkbenchTheme,
} from '@/shared/api'
import type {
  CdpStatus,
  McpStatus,
  WorkbenchSettingsValue,
  ThemeSource,
} from '@/shared/api'
import { computeMcpNeedsRestart, McpTab } from './mcp-settings-tab'

const TABS = [
  { id: 'general', label: '通用' },
  { id: 'debug', label: '调试' },
  { id: 'mcp', label: 'MCP' },
] as const

type TabId = (typeof TABS)[number]['id']

// Exported for unit testing; not part of the component's public API.
export const THEME_LABELS: Record<ThemeSource, string> = {
  system: '跟随系统',
  dark: '深色',
  light: '浅色',
}

/**
 * Active state: Cornetto `Button` `secondary` variant (neutral chip + near-
 * white/black text) rather than `soft` (primary-soft bg + primary text) —
 * `soft`'s text contrast sits under WCAG AA 4.5:1 for normal text in dark
 * mode (~3:1, same primary-on-primary-soft pairing flagged for icon strokes
 * in LayoutVisibilityToggles). `secondary` matches that fix's approach.
 */
function ThemeModeSelector({ theme, onSelect }: { theme: ThemeSource, onSelect: (theme: ThemeSource) => void }) {
  return (
    <div className="flex gap-1">
      {(['system', 'dark', 'light'] as ThemeSource[]).map((mode) => (
        <Button
          key={mode}
          variant={theme === mode ? 'secondary' : 'ghost'}
          size="xs"
          onClick={() => onSelect(mode)}
        >
          {THEME_LABELS[mode]}
        </Button>
      ))}
    </div>
  )
}

function GeneralTab({
  autoBuildEnabled,
  onAutoBuildChange,
  autoReloadEnabled,
  onAutoReloadChange,
  theme,
  onThemeChange,
  saved,
}: {
  autoBuildEnabled: boolean
  onAutoBuildChange: (autoBuild: boolean) => void
  autoReloadEnabled: boolean
  onAutoReloadChange: (autoReload: boolean) => void
  theme: ThemeSource
  onThemeChange: (theme: ThemeSource) => void
  saved: boolean
}) {
  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border p-4 space-y-4 bg-bg">
        <div>
          <h2 className="text-[13px] font-medium mb-1">编译与预览</h2>
          <p className="text-[11px] leading-relaxed text-text-secondary">开启「自动编译」后，打开项目时会监听源文件改动并自动重新编译。开启「自动刷新」后，每次编译完成会刷新模拟器（仅改样式时原地热替换，保留当前页面栈与表单状态）；关闭它则任何改动都不刷新，仅手动刷新。配置在下次打开项目时生效。</p>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-text-secondary">监听文件变化自动编译</span>
          <Switch checked={autoBuildEnabled} onCheckedChange={onAutoBuildChange} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-text-secondary">编译完成后自动刷新模拟器</span>
          <Switch checked={autoReloadEnabled} onCheckedChange={onAutoReloadChange} />
        </div>
      </section>

      <section className="rounded-lg border border-border p-4 space-y-3 bg-bg">
        <div>
          <h2 className="text-[13px] font-medium mb-1">外观</h2>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-text-secondary">颜色模式</span>
          <ThemeModeSelector theme={theme} onSelect={onThemeChange} />
        </div>
      </section>

      {saved && (
        <div className="text-[11px] text-status-success">已保存</div>
      )}
    </div>
  )
}

function CdpStatusPanel({ cdpStatus }: { cdpStatus: CdpStatus | null }) {
  return (
    <div className="rounded p-3 space-y-2 border border-border bg-surface">
      <div className="text-[11px] font-medium text-text-secondary">当前状态</div>
      <div className="flex items-center gap-2">
        <span
          className={`inline-block w-2 h-2 rounded-full ${cdpStatus?.active ? 'bg-status-success' : 'bg-text-dim'}`}
        />
        <span className="text-[12px] text-text-secondary">
          {cdpStatus?.active
            ? `CDP 已激活 - 端口 ${cdpStatus.activePort}`
            : 'CDP 未激活'}
        </span>
      </div>
      {cdpStatus?.implicitDevDefault && (
        <div className="text-[11px] text-text-dim">
          当前为开发模式默认端口
        </div>
      )}
      {cdpStatus?.active && (
        <div className="text-[11px] text-text-dim font-mono">
          调试地址: http://localhost:{cdpStatus.activePort}
        </div>
      )}
    </div>
  )
}

/**
 * Whether the CDP config differs from what's actually active — a change only
 * takes effect after a restart, so the debug tab shows a warning until then.
 * `implicitDevDefault` (dev mode always listening) never needs a restart nag.
 */
export function computeNeedsRestart(cdpStatus: CdpStatus | null, cdp: WorkbenchSettingsValue['cdp']): boolean {
  if (!cdpStatus || cdpStatus.implicitDevDefault) return false
  if (cdp.enabled !== cdpStatus.active) return true
  return cdp.enabled && cdpStatus.active && cdp.port !== cdpStatus.activePort
}

function DebugTab({
  cdpEnabled,
  onToggleCdp,
  portInput,
  onPortInputChange,
  cdpStatus,
  needsRestart,
  onSave,
  saved,
}: {
  cdpEnabled: boolean
  onToggleCdp: () => void
  portInput: string
  onPortInputChange: (value: string) => void
  cdpStatus: CdpStatus | null
  needsRestart: boolean
  onSave: () => void
  saved: boolean
}) {
  return (
    <section className="rounded-lg border border-border p-4 space-y-4 bg-bg">
      <div>
        <h2 className="text-[13px] font-medium mb-1">DevTools Protocol</h2>
        <p className="text-[11px] leading-relaxed text-text-secondary">
          开启后可通过 DevTools Protocol 连接调试模拟器。配置变更需要重启应用后生效。
        </p>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[12px] text-text-secondary">启用 DevTools Protocol</span>
        <Switch checked={cdpEnabled} onCheckedChange={onToggleCdp} />
      </div>

      <div className="flex items-center gap-3">
        <label className="text-[12px] shrink-0 w-16 text-text-secondary">调试端口</label>
        <Input
          type="number"
          min={1024}
          max={65535}
          value={portInput}
          onChange={(e) => onPortInputChange(e.target.value)}
          disabled={!cdpEnabled}
          className="w-24 h-7 px-2 text-[12px]"
        />
        <span className="text-[11px] text-text-dim">默认 {DEFAULT_CDP_PORT}</span>
      </div>

      <CdpStatusPanel cdpStatus={cdpStatus} />

      {needsRestart && (
        <div className="rounded px-3 py-2 text-[12px] border bg-warn-bg text-[var(--color-status-warn)]">
          配置已变更，需要重启应用后生效
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={onSave}>
          保存
        </Button>
        {saved && <span className="text-[11px] text-status-success">已保存</span>}
      </div>
    </section>
  )
}

export default function WorkbenchSettings() {
  const [settings, setSettings] = useState<WorkbenchSettingsValue>({
    cdp: { enabled: false, port: DEFAULT_CDP_PORT },
    mcp: { enabled: false, port: 7789 },
    compile: { autoBuild: true },
    preview: { autoReload: true },
    theme: 'system',
    lastCreateBaseDir: null, // required by save schema; overwritten on first load
  })
  const [cdpStatus, setCdpStatus] = useState<CdpStatus | null>(null)
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null)
  const [activeTab, setActiveTab] = useState<TabId>('general')
  const [saved, setSaved] = useState(false)
  const [portInput, setPortInput] = useState(String(DEFAULT_CDP_PORT))
  const [mcpPortInput, setMcpPortInput] = useState('7789')

  useEffect(() => {
    const off = onWorkbenchSettingsInit((data) => {
      setSettings(data.settings)
      setPortInput(String(data.settings.cdp.port))
      setMcpPortInput(String(data.settings.mcp.port))
    })
    getWorkbenchSettings().then((s) => {
      setSettings(s)
      setPortInput(String(s.cdp.port))
      setMcpPortInput(String(s.mcp.port))
    })
    getCdpStatus().then(setCdpStatus)
    getMcpStatus().then(setMcpStatus)
    return off
  }, [])

  function flashSaved() {
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2000)
  }

  function toggleCdp() {
    setSettings((prev) => ({
      ...prev,
      cdp: { ...prev.cdp, enabled: !prev.cdp.enabled },
    }))
  }

  function toggleMcp() {
    setSettings((prev) => ({
      ...prev,
      mcp: { ...prev.mcp, enabled: !prev.mcp.enabled },
    }))
  }

  function handleThemeChange(theme: ThemeSource) {
    const next = { ...settings, theme }
    setSettings(next)
    void setWorkbenchTheme(theme)
    void saveWorkbenchSettings(next)
  }

  function persistSettings(next: WorkbenchSettingsValue) {
    setSettings(next)
    void saveWorkbenchSettings(next).then(flashSaved)
  }

  function buildSettingsFromInputs(): WorkbenchSettingsValue | null {
    const port = parseInt(portInput, 10)
    if (Number.isNaN(port) || port < 1024 || port > 65535) return null
    const mcpPort = parseInt(mcpPortInput, 10)
    if (Number.isNaN(mcpPort) || mcpPort < 1024 || mcpPort > 65535) return null

    return {
      ...settings,
      cdp: { ...settings.cdp, port },
      mcp: { ...settings.mcp, port: mcpPort },
    }
  }

  async function handleSave() {
    const next = buildSettingsFromInputs()
    if (!next) return
    setSettings(next)
    await saveWorkbenchSettings(next)
    setCdpStatus(await getCdpStatus())
    setMcpStatus(await getMcpStatus())
    flashSaved()
  }

  async function handleRestart() {
    const next = buildSettingsFromInputs()
    if (!next) return
    setSettings(next)
    await saveWorkbenchSettings(next)
    await restartWorkbench()
  }

  const pendingSettings = buildSettingsFromInputs() ?? settings
  const needsRestart = computeNeedsRestart(cdpStatus, pendingSettings.cdp)
  const mcpNeedsRestart = computeMcpNeedsRestart(mcpStatus, pendingSettings.mcp)

  return (
    <div className="flex flex-col h-screen bg-surface text-text">
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabId)} className="shrink-0 gap-0">
        <TabsList className="w-full">
          {TABS.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id} className="flex-1 justify-center">
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'general' && (
          <GeneralTab
            autoBuildEnabled={settings.compile.autoBuild}
            onAutoBuildChange={(autoBuild) => persistSettings({ ...settings, compile: { ...settings.compile, autoBuild } })}
            autoReloadEnabled={settings.preview.autoReload}
            onAutoReloadChange={(autoReload) => persistSettings({ ...settings, preview: { ...settings.preview, autoReload } })}
            theme={settings.theme}
            onThemeChange={handleThemeChange}
            saved={saved}
          />
        )}

        {activeTab === 'debug' && (
          <DebugTab
            cdpEnabled={settings.cdp.enabled}
            onToggleCdp={toggleCdp}
            portInput={portInput}
            onPortInputChange={setPortInput}
            cdpStatus={cdpStatus}
            needsRestart={needsRestart}
            onSave={handleSave}
            saved={saved}
          />
        )}

        {activeTab === 'mcp' && (
          <McpTab
            mcpEnabled={settings.mcp.enabled}
            onToggleMcp={toggleMcp}
            mcpPortInput={mcpPortInput}
            onMcpPortInputChange={setMcpPortInput}
            mcpStatus={mcpStatus}
            mcpPort={pendingSettings.mcp.port}
            needsRestart={mcpNeedsRestart}
            onSave={handleSave}
            onRestart={handleRestart}
            saved={saved}
          />
        )}
      </div>
    </div>
  )
}
