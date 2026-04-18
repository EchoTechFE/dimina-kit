import React, { useState, useEffect } from 'react'
import { Input } from '@/shared/components/ui/input'
import {
  emitProjectSettingsChanged,
  emitSettingsConfigChanged,
  onSettingsInit,
} from '@/shared/api'

interface CompileConfig {
  startPage: string
  scene: number
  queryParams: Array<{ key: string; value: string }>
}

const TABS = [
  { id: 'local', label: '本地设置' },
  { id: 'project', label: '项目配置' },
] as const

type TabId = (typeof TABS)[number]['id']

export default function Settings() {
  const [activeTab, setActiveTab] = useState<TabId>('local')
  const [projectPath, setProjectPath] = useState('')
  const [config, setConfig] = useState<CompileConfig>({
    startPage: '',
    scene: 1001,
    queryParams: [],
  })
  const [projectSettings, setProjectSettings] = useState({
    uploadWithSourceMap: false,
  })

  useEffect(() => {
    return onSettingsInit((data) => {
      setProjectPath(data.projectPath)
      setConfig(data.config)
      setProjectSettings({
        uploadWithSourceMap: !!data.projectSettings?.uploadWithSourceMap,
      })
    })
  }, [])

  function updateConfig(patch: Partial<CompileConfig>) {
    const next = { ...config, ...patch }
    setConfig(next)
    emitSettingsConfigChanged(next)
  }

  function updateProjectSettings(patch: Partial<typeof projectSettings>) {
    const next = { ...projectSettings, ...patch }
    setProjectSettings(next)
    emitProjectSettingsChanged(next)
  }

  function renderCheckItem(
    label: string,
    checked: boolean,
    onChange: (checked: boolean) => void
  ) {
    return (
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md border border-border bg-bg hover:bg-surface-3 transition-colors text-left"
      >
        <span
          className={`h-4 w-4 rounded-sm border flex items-center justify-center text-[11px] ${
            checked
              ? 'bg-accent border-accent text-white'
              : 'border-border bg-surface text-transparent'
          }`}
        >
          ✓
        </span>
        <span className="text-[12px] text-text">{label}</span>
      </button>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-surface text-text">
      <div className="flex items-center border-b border-border shrink-0">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`flex-1 py-2.5 text-[12px] text-center transition-colors ${
              activeTab === tab.id
                ? 'text-accent border-b-2 border-accent'
                : 'text-text-secondary hover:text-text'
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'local' && (
          <div className="space-y-3">
            <div className="text-[12px] text-text-secondary">本地设置</div>
            {renderCheckItem(
              '上传时启用 Sourcemap',
              projectSettings.uploadWithSourceMap,
              (checked) => updateProjectSettings({ uploadWithSourceMap: checked })
            )}
          </div>
        )}
        {activeTab === 'project' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between py-2 border-b border-border">
              <span className="text-[12px] text-text-secondary">本地目录</span>
              <span
                className="text-[12px] text-text truncate ml-4 max-w-[180px]"
                title={projectPath}
              >
                {projectPath}
              </span>
            </div>

            <div>
              <label className="block text-[12px] text-text-secondary mb-1">启动页面</label>
              <Input
                value={config.startPage}
                onChange={(e) => updateConfig({ startPage: e.target.value })}
                className="w-full h-8 px-2 text-[12px]"
              />
            </div>

            <div>
              <label className="block text-[12px] text-text-secondary mb-1">Scene</label>
              <Input
                type="number"
                value={config.scene}
                onChange={(e) => updateConfig({ scene: parseInt(e.target.value || '1001', 10) })}
                className="w-full h-8 px-2 text-[12px]"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
