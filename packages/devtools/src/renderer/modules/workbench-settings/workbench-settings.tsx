import React, { useEffect, useState } from 'react'
import {
  getCdpStatus,
  getWorkbenchSettings,
  onWorkbenchSettingsInit,
  saveWorkbenchSettings,
  setWorkbenchTheme,
} from '@/shared/api'
import type {
  CdpStatus,
  WorkbenchSettingsValue,
  ThemeSource,
} from '@/shared/api'

export default function WorkbenchSettings() {
  const [settings, setSettings] = useState<WorkbenchSettingsValue>({
    cdp: { enabled: false, port: 9222 },
    mcp: { enabled: false, port: 7789 },
    theme: 'system',
  })
  const [cdpStatus, setCdpStatus] = useState<CdpStatus | null>(null)
  const [saved, setSaved] = useState(false)
  const [portInput, setPortInput] = useState('9222')
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
    return off
  }, [])

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
    setSettings((prev) => ({ ...prev, theme }))
    void setWorkbenchTheme(theme)
  }

  async function handleSave() {
    const port = parseInt(portInput, 10)
    if (Number.isNaN(port) || port < 1024 || port > 65535) return
    const mcpPort = parseInt(mcpPortInput, 10)
    if (Number.isNaN(mcpPort) || mcpPort < 1024 || mcpPort > 65535) return

    const next: WorkbenchSettingsValue = {
      ...settings,
      cdp: { ...settings.cdp, port },
      mcp: { ...settings.mcp, port: mcpPort },
    }
    setSettings(next)
    await saveWorkbenchSettings(next)
    setCdpStatus(await getCdpStatus())
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2000)
  }

  const needsRestart =
    cdpStatus &&
    !cdpStatus.implicitDevDefault &&
    (settings.cdp.enabled !== cdpStatus.active ||
      (settings.cdp.enabled && cdpStatus.active && settings.cdp.port !== cdpStatus.activePort))

  return (
    <div className="h-screen overflow-y-auto p-4 bg-surface text-text">
      <section className="rounded-lg border border-border p-4 space-y-4 bg-bg">
        <div>
          <h2 className="text-[13px] font-medium mb-1">开发工具设置</h2>
          <p className="text-[11px] leading-relaxed text-text-secondary">
            这里是开发工具全局能力，不属于任何具体小程序项目。开启后可通过 DevTools Protocol
            连接调试模拟器，MCP 服务器也会使用这里的端口配置。
          </p>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[12px] text-text-secondary">启用 DevTools Protocol</span>
          <button
            onClick={toggleCdp}
            className="relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors"
            style={{ background: settings.cdp.enabled ? 'var(--color-accent)' : 'var(--color-surface-3)' }}
          >
            <span
              className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform"
              style={{ marginTop: 3, transform: settings.cdp.enabled ? 'translateX(18px)' : 'translateX(3px)' }}
            />
          </button>
        </div>

        <div className="flex items-center gap-3">
          <label className="text-[12px] shrink-0 w-16 text-text-secondary">调试端口</label>
          <input
            type="number"
            min={1024}
            max={65535}
            value={portInput}
            onChange={(e) => setPortInput(e.target.value)}
            disabled={!settings.cdp.enabled}
            className="w-24 h-7 px-2 rounded text-[12px] outline-none bg-surface border border-border text-text"
            style={{ opacity: settings.cdp.enabled ? 1 : 0.4 }}
          />
          <span className="text-[11px] text-text-dim">默认 9222</span>
        </div>

        <div className="rounded p-3 space-y-2 border border-border bg-surface">
          <div className="text-[11px] font-medium text-text-secondary">当前状态</div>
          <div className="flex items-center gap-2">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: cdpStatus?.active ? 'var(--color-status-success)' : 'var(--color-text-dim)' }}
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

        {needsRestart && (
          <div className="rounded px-3 py-2 text-[12px] border bg-warn-bg text-[var(--color-status-warn)]">
            配置已变更，需要重启应用后生效
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            className="h-7 px-4 rounded text-[13px] font-medium text-white bg-accent hover:bg-accent-hover"
          >
            保存
          </button>
          {saved && <span className="text-[11px] text-status-success">已保存</span>}
        </div>
      </section>

      <section className="rounded-lg border border-border p-4 space-y-3 mt-4 bg-bg">
        <div>
          <h2 className="text-[13px] font-medium mb-1">外观</h2>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-text-secondary">颜色模式</span>
          <div className="flex rounded overflow-hidden border border-border text-[11px]">
            {(['system', 'dark', 'light'] as ThemeSource[]).map((mode, i) => {
              const label = mode === 'system' ? '跟随系统' : mode === 'dark' ? '深色' : '浅色'
              const active = settings.theme === mode
              return (
                <button
                  key={mode}
                  onClick={() => handleThemeChange(mode)}
                  className={[
                    'px-3 py-1 transition-colors',
                    i > 0 ? 'border-l border-border' : '',
                    active
                      ? 'bg-accent text-white'
                      : 'text-text-secondary hover:text-text hover:bg-surface-3',
                  ].join(' ')}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border p-4 space-y-4 mt-4 bg-bg">
        <div>
          <h2 className="text-[13px] font-medium mb-1">MCP 配置</h2>
          <p className="text-[11px] leading-relaxed text-text-secondary">
            AI 助手可以通过 MCP 连接当前开发工具，读取 console、截图、执行 JS、查看 DOM / Storage /
            网络请求。启用后开发工具启动时会自动监听 SSE 端点，并自动启用 CDP。
          </p>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[12px] text-text-secondary">启用 MCP 服务</span>
          <button
            onClick={toggleMcp}
            className="relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors"
            style={{ background: settings.mcp.enabled ? 'var(--color-accent)' : 'var(--color-surface-3)' }}
          >
            <span
              className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform"
              style={{ marginTop: 3, transform: settings.mcp.enabled ? 'translateX(18px)' : 'translateX(3px)' }}
            />
          </button>
        </div>

        <div className="flex items-center gap-3">
          <label className="text-[12px] shrink-0 w-16 text-text-secondary">SSE 端口</label>
          <input
            type="number"
            min={1024}
            max={65535}
            value={mcpPortInput}
            onChange={(e) => setMcpPortInput(e.target.value)}
            disabled={!settings.mcp.enabled}
            className="w-24 h-7 px-2 rounded text-[12px] outline-none bg-surface border border-border text-text"
            style={{ opacity: settings.mcp.enabled ? 1 : 0.4 }}
          />
          <span className="text-[11px] text-text-dim">默认 7789</span>
        </div>

        <div className="rounded p-3 border border-border bg-surface">
          <div className="text-[11px] font-medium mb-2 text-text-secondary">`.mcp.json` 示例（SSE 传输）</div>
          <pre className="text-[11px] whitespace-pre-wrap leading-relaxed text-[var(--color-code-blue)] font-mono">{`{
  "mcpServers": {
    "dimina-devtools": {
      "url": "http://127.0.0.1:${settings.mcp.port}/sse"
    }
  }
}`}</pre>
        </div>
      </section>
    </div>
  )
}
