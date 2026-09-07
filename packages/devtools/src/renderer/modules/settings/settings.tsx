import React, { useState, useEffect } from 'react'
import { Switch } from '@/shared/components/ui/switch'
import { SettingsTabBar } from '@/shared/components/settings-tab-bar'
import {
  emitProjectSettingsChanged,
  onSettingsInit,
  notifyOverlayReady,
  setSettingsVisible,
} from '@/shared/api'

const TABS = [
  { id: 'local', label: '本地设置' },
  { id: 'project', label: '项目配置' },
] as const

type TabId = (typeof TABS)[number]['id']

export default function Settings() {
  const [activeTab, setActiveTab] = useState<TabId>('local')
  const [projectPath, setProjectPath] = useState('')
  const [projectSettings, setProjectSettings] = useState({
    uploadWithSourceMap: false,
  })

  useEffect(() => {
    const off = onSettingsInit((data) => {
      setProjectPath(data.projectPath)
      setProjectSettings({
        uploadWithSourceMap: !!data.projectSettings?.uploadWithSourceMap,
      })
    })
    notifyOverlayReady()
    return off
  }, [])

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
      <label className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-[var(--qd-radius-md)] border border-border bg-bg cursor-pointer">
        <span className="text-[12px] text-text">{label}</span>
        <Switch checked={checked} onCheckedChange={onChange} />
      </label>
    )
  }

  return (
    // The view spans the whole content area; this transparent backdrop catches a
    // click OUTSIDE the panel and closes the overlay. The opaque panel below
    // stops propagation so interacting with its controls never self-closes.
    <div
      data-testid="settings-backdrop"
      className="fixed inset-0"
      onClick={() => void setSettingsVisible(false)}
    >
    <div
      data-testid="settings-panel"
      className="fixed top-0 right-0 h-full w-[320px] flex flex-col bg-surface text-text border-l border-border shadow-[0_8px_24px_var(--color-overlay-heavy)]"
      onClick={(e) => e.stopPropagation()}
    >
      <SettingsTabBar tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} />

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

            {/* 启动页面 / scene are NOT edited here: the compile-mode dropdown
                owns them, and a second editor of the same state would silently
                write a configuration no mode in the list describes. */}
          </div>
        )}
      </div>
    </div>
    </div>
  )
}
