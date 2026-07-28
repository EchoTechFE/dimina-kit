import type { ReactNode } from 'react'
import type { McpStatus, WorkbenchSettingsValue } from '@/shared/api'

const MCP_SERVER_NAME = 'dimina'

export interface McpClientRegistration {
  url: string
  claudeCode: string
  codex: string
  mcpJson: string
}

export function buildMcpClientRegistration(port: number): McpClientRegistration {
  const url = `http://127.0.0.1:${port}/sse`
  return {
    url,
    claudeCode: `claude mcp add --transport sse ${MCP_SERVER_NAME} ${url}`,
    codex: `codex mcp add ${MCP_SERVER_NAME} --url ${url}`,
    mcpJson: `{
  "mcpServers": {
    "${MCP_SERVER_NAME}": {
      "url": "${url}"
    }
  }
}`,
  }
}

export function computeMcpNeedsRestart(
  mcpStatus: McpStatus | null,
  mcp: WorkbenchSettingsValue['mcp'],
): boolean {
  if (!mcpStatus) return false
  if (mcp.enabled !== mcpStatus.running) return true
  return mcp.enabled && mcpStatus.running && mcp.port !== mcpStatus.activePort
}

function StatusRow({ color, children }: { color: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{ background: color }}
      />
      <span className="text-[12px] text-text-secondary">{children}</span>
    </div>
  )
}

function McpStatusPanel({
  mcpEnabled,
  mcpStatus,
}: {
  mcpEnabled: boolean
  mcpStatus: McpStatus | null
}) {
  return (
    <div className="rounded p-3 space-y-2 border border-border bg-surface">
      <div className="text-[11px] font-medium text-text-secondary">当前状态</div>
      {!mcpEnabled ? (
        <StatusRow color="var(--color-text-dim)">MCP 未启用</StatusRow>
      ) : mcpStatus?.running ? (
        <StatusRow color="var(--color-status-success)">
          MCP 已运行 - 端口 {mcpStatus.activePort}
        </StatusRow>
      ) : (
        <StatusRow color="var(--color-status-error, #e54d4d)">
          MCP 未运行
          {mcpStatus?.error === 'port-in-use'
            ? `（端口 ${mcpStatus.configuredPort} 已被占用）`
            : mcpStatus?.error
              ? `（${mcpStatus.error}）`
              : ''}
        </StatusRow>
      )}
    </div>
  )
}

export function McpTab({
  mcpEnabled,
  onToggleMcp,
  mcpPortInput,
  onMcpPortInputChange,
  mcpStatus,
  mcpPort,
  needsRestart,
  onSave,
  onRestart,
  saved,
}: {
  mcpEnabled: boolean
  onToggleMcp: () => void
  mcpPortInput: string
  onMcpPortInputChange: (value: string) => void
  mcpStatus: McpStatus | null
  mcpPort: number
  needsRestart: boolean
  onSave: () => void
  onRestart: () => void
  saved: boolean
}) {
  const registration = buildMcpClientRegistration(mcpPort)

  return (
    <section className="rounded-lg border border-border p-4 space-y-4 bg-bg">
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
          type="button"
          onClick={onToggleMcp}
          className="relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors"
          style={{ background: mcpEnabled ? 'var(--color-accent)' : 'var(--color-surface-3)' }}
        >
          <span
            className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform"
            style={{ marginTop: 3, transform: mcpEnabled ? 'translateX(18px)' : 'translateX(3px)' }}
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
          onChange={(e) => onMcpPortInputChange(e.target.value)}
          disabled={!mcpEnabled}
          className="w-24 h-7 px-2 rounded text-[12px] outline-none bg-surface border border-border text-text"
          style={{ opacity: mcpEnabled ? 1 : 0.4 }}
        />
        <span className="text-[11px] text-text-dim">默认 7789</span>
      </div>

      <McpStatusPanel mcpEnabled={mcpEnabled} mcpStatus={mcpStatus} />

      {needsRestart && (
        <div className="rounded px-3 py-2 text-[12px] border bg-warn-bg text-[var(--color-status-warn)] flex items-center justify-between gap-3">
          <span>配置已变更，需要重启应用后生效</span>
          <button
            onClick={onRestart}
            className="h-7 px-3 rounded text-[12px] font-medium text-white bg-accent hover:bg-accent-hover shrink-0"
          >
            保存并重启
          </button>
        </div>
      )}

      <div className="rounded p-3 border border-border bg-surface">
        <div className="text-[11px] font-medium mb-2 text-text-secondary">本地客户端注册</div>
        <div className="space-y-3">
          <div>
            <div className="text-[11px] mb-1 text-text-dim">Claude Code</div>
            <pre className="text-[11px] whitespace-pre-wrap leading-relaxed text-[var(--color-code-blue)] font-mono">{registration.claudeCode}</pre>
          </div>
          <div>
            <div className="text-[11px] mb-1 text-text-dim">Codex</div>
            <pre className="text-[11px] whitespace-pre-wrap leading-relaxed text-[var(--color-code-blue)] font-mono">{registration.codex}</pre>
          </div>
        </div>
      </div>

      <div className="rounded p-3 border border-border bg-surface">
        <div className="text-[11px] font-medium mb-2 text-text-secondary">`.mcp.json` 示例（SSE 传输）</div>
        <pre className="text-[11px] whitespace-pre-wrap leading-relaxed text-[var(--color-code-blue)] font-mono">{registration.mcpJson}</pre>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onSave}
          className="h-7 px-4 rounded text-[13px] font-medium text-white bg-accent hover:bg-accent-hover"
        >
          保存
        </button>
        {saved && <span className="text-[11px] text-status-success">已保存</span>}
      </div>
    </section>
  )
}
