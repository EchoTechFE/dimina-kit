import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Select } from '@/shared/components/ui/select'
import { DEFAULT_SCENE } from '../../../shared/constants'
import { POPOVER_WIDTH_PX, POPOVER_MARGIN_PX } from '../../shared/constants'
import {
  emitPopoverRelaunch,
  emitPopoverSwitchLaunchConfig,
  emitPopoverUpdateLaunchConfigs,
  hidePopover,
  onPopoverInit,
} from '@/shared/api'
import type { CompileConfig, LaunchConfig } from '../../shared/types'

type EditorState =
  | { mode: 'normal' }
  | { mode: 'create' }
  | { mode: 'edit'; id: string }

export default function Popover() {
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const [pages, setPages] = useState<string[]>([])
  const [launchConfigs, setLaunchConfigs] = useState<LaunchConfig[]>([])
  const [activeLaunchConfigId, setActiveLaunchConfigId] = useState<string | null>(null)
  const [normalConfig, setNormalConfig] = useState<CompileConfig>({
    startPage: '',
    scene: DEFAULT_SCENE,
    queryParams: [],
  })

  // null = list view, non-null = editor view
  const [editorState, setEditorState] = useState<EditorState | null>(null)
  const [editorName, setEditorName] = useState('')
  const [editorConfig, setEditorConfig] = useState<CompileConfig>({
    startPage: '',
    scene: DEFAULT_SCENE,
    queryParams: [],
  })

  useEffect(() => {
    return onPopoverInit((data) => {
      setPages(data.pages)
      const nextLaunchConfigs = data.launchConfigs ?? []
      const nextActiveLaunchConfigId = data.activeLaunchConfigId ?? null
      setLaunchConfigs(nextLaunchConfigs)
      setActiveLaunchConfigId(nextActiveLaunchConfigId)
      setNormalConfig(data.config)
      const maxLeft = window.innerWidth - POPOVER_WIDTH_PX - POPOVER_MARGIN_PX
      setPosition({ top: data.top, left: Math.min(data.left, maxLeft) })
      if (nextLaunchConfigs.length === 0 && nextActiveLaunchConfigId === null) {
        setEditorState({ mode: 'normal' })
        setEditorConfig(data.config)
      } else {
        setEditorState(null)
      }
    })
  }, [])

  function handleOverlayClick() {
    void hidePopover()
  }

  // ── List view handlers ──────────────────────────────────────────────────

  const handleSwitchConfig = useCallback((id: string | null) => {
    emitPopoverSwitchLaunchConfig(id)
  }, [])

  const handleStartNormalEdit = useCallback(() => {
    setEditorState({ mode: 'normal' })
    setEditorConfig(normalConfig)
  }, [normalConfig])

  const handleStartEdit = useCallback((lc: LaunchConfig) => {
    setEditorState({ mode: 'edit', id: lc.id })
    setEditorName(lc.name)
    setEditorConfig({
      startPage: lc.startPage,
      scene: lc.scene,
      queryParams: [...lc.queryParams.map((p) => ({ ...p }))],
    })
  }, [])

  const handleStartCreate = useCallback(() => {
    setEditorState({ mode: 'create' })
    setEditorName('')
    setEditorConfig({
      startPage: pages[0] ?? '',
      scene: DEFAULT_SCENE,
      queryParams: [],
    })
  }, [pages])

  const handleDelete = useCallback((id: string) => {
    const next = launchConfigs.filter((c) => c.id !== id)
    setLaunchConfigs(next)
    emitPopoverUpdateLaunchConfigs(next)
    if (activeLaunchConfigId === id) {
      emitPopoverSwitchLaunchConfig(null)
      setActiveLaunchConfigId(null)
    }
  }, [launchConfigs, activeLaunchConfigId])

  // ── Editor view handlers ────────────────────────────────────────────────

  function addParam() {
    setEditorConfig((c) => ({
      ...c,
      queryParams: [...c.queryParams, { key: '', value: '' }],
    }))
  }

  function removeParam(idx: number) {
    setEditorConfig((c) => ({
      ...c,
      queryParams: c.queryParams.filter((_, i) => i !== idx),
    }))
  }

  function updateParam(idx: number, field: 'key' | 'value', value: string) {
    setEditorConfig((c) => {
      const next = [...c.queryParams]
      const prev = next[idx] ?? { key: '', value: '' }
      next[idx] = { ...prev, [field]: value }
      return { ...c, queryParams: next }
    })
  }

  function handleEditorSave() {
    if (!editorState) return
    if (editorState.mode === 'normal') {
      setNormalConfig(editorConfig)
      emitPopoverRelaunch(editorConfig)
      void hidePopover()
      return
    }
    const trimmed = editorName.trim()
    if (!trimmed) return

    if (editorState.mode === 'create') {
      const newConfig: LaunchConfig = {
        id: crypto.randomUUID(),
        name: trimmed,
        startPage: editorConfig.startPage,
        scene: editorConfig.scene,
        queryParams: editorConfig.queryParams,
      }
      const next = [...launchConfigs, newConfig]
      setLaunchConfigs(next)
      emitPopoverUpdateLaunchConfigs(next)
    } else {
      const next = launchConfigs.map((lc) =>
        lc.id === editorState.id
          ? {
              ...lc,
              name: trimmed,
              startPage: editorConfig.startPage,
              scene: editorConfig.scene,
              queryParams: editorConfig.queryParams,
            }
          : lc,
      )
      setLaunchConfigs(next)
      emitPopoverUpdateLaunchConfigs(next)
    }
    setEditorState(null)
  }

  function handleEditorCancel() {
    if (editorState?.mode === 'normal' && launchConfigs.length === 0 && activeLaunchConfigId === null) {
      void hidePopover()
      return
    }
    setEditorState(null)
  }

  // ── Render ──────────────────────────────────────────────────────────────

  const showMissingStartPageOption =
    editorConfig.startPage !== '' && !pages.includes(editorConfig.startPage)

  return (
    <>
      <div className="fixed inset-0" onClick={handleOverlayClick} />

      <div
        className="fixed w-[340px] bg-surface border border-border-strong rounded-md shadow-[0_8px_24px_var(--color-overlay-heavy)] z-10"
        style={{ top: position.top, left: position.left }}
        onClick={(e) => e.stopPropagation()}
      >
        {editorState === null ? (
          /* ── List view ────────────────────────────────────────── */
          <div className="p-2">
            {/* Normal compile entry */}
            <button
              type="button"
              className={
                'w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-[12px] text-left hover:bg-surface-hover'
                + (activeLaunchConfigId === null ? ' bg-surface-active' : '')
              }
              onClick={() => {
                if (activeLaunchConfigId === null) handleStartNormalEdit()
                else handleSwitchConfig(null)
              }}
            >
              <span className="w-4 text-center text-accent shrink-0">
                {activeLaunchConfigId === null ? '✓' : ''}
              </span>
              <span className="flex-1 text-text truncate">普通编译</span>
            </button>

            {/* Saved launch configs */}
            {launchConfigs.map((lc) => (
              <div
                key={lc.id}
                className={
                  'w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-[12px] group hover:bg-surface-hover'
                  + (activeLaunchConfigId === lc.id ? ' bg-surface-active' : '')
                }
              >
                <button
                  type="button"
                  className="flex items-center gap-2 flex-1 min-w-0 text-left"
                  onClick={() => handleSwitchConfig(lc.id)}
                >
                  <span className="w-4 text-center text-accent shrink-0">
                    {activeLaunchConfigId === lc.id ? '✓' : ''}
                  </span>
                  <span className="flex-1 text-text truncate">{lc.name}</span>
                </button>
                <span className="flex gap-0.5 opacity-0 group-hover:opacity-100">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-text-secondary hover:text-accent hover:bg-transparent"
                    onClick={() => handleStartEdit(lc)}
                    title="编辑"
                  >
                    ✎
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-text-secondary hover:text-status-error hover:bg-transparent"
                    onClick={() => handleDelete(lc.id)}
                    title="删除"
                  >
                    ×
                  </Button>
                </span>
              </div>
            ))}

            {/* Add button */}
            <div className="mt-1 border-t border-border pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-[12px] text-text-secondary hover:text-accent"
                onClick={handleStartCreate}
              >
                + 添加编译模式
              </Button>
            </div>
          </div>
        ) : (
          /* ── Editor view ──────────────────────────────────────── */
          <div className="p-3.5">
            {editorState.mode !== 'normal' && (
              <div className="flex items-center gap-2.5 mb-3">
                <label className="w-16 shrink-0 text-code-label text-[12px]">
                  名称
                </label>
                <Input
                  className="flex-1 min-w-0 bg-surface-input border-text-dim text-text text-[12px]"
                  value={editorName}
                  placeholder="编译模式名称"
                  onChange={(e) => setEditorName(e.target.value)}
                  autoFocus
                />
              </div>
            )}

            <div className="flex items-center gap-2.5 mb-3">
              <label className="w-16 shrink-0 text-code-label text-[12px]">
                启动页面
              </label>
              <Select
                className="flex-1 min-w-0 bg-surface-input border-text-dim text-text text-[12px] py-0.5"
                value={editorConfig.startPage}
                onChange={(e) =>
                  setEditorConfig((c) => ({ ...c, startPage: e.target.value }))
                }
              >
                {showMissingStartPageOption && (
                  <option value={editorConfig.startPage}>
                    {editorConfig.startPage}（页面不存在）
                  </option>
                )}
                {pages.map((pg) => (
                  <option key={pg} value={pg}>
                    {pg}
                  </option>
                ))}
              </Select>
            </div>

            <div className="flex items-center gap-2.5 mb-3">
              <label className="w-16 shrink-0 text-code-label text-[12px]">
                scene 值
              </label>
              <Input
                type="number"
                className="w-20 bg-surface-input border-text-dim text-text text-[12px]"
                value={editorConfig.scene}
                onChange={(e) =>
                  setEditorConfig((c) => ({
                    ...c,
                    scene: Number(e.target.value) || DEFAULT_SCENE,
                  }))
                }
              />
            </div>

            <div className="flex items-start gap-2.5 mb-3">
              <label className="w-16 shrink-0 text-code-label text-[12px] pt-1">
                启动参数
              </label>
              <div className="flex flex-col gap-1.5 flex-1">
                {editorConfig.queryParams.map((p, i) => (
                  <div key={i} className="flex gap-1.5 items-center">
                    <Input
                      className="w-24 bg-surface-input border-text-dim text-text text-[12px]"
                      value={p.key}
                      placeholder="参数名"
                      onChange={(e) => updateParam(i, 'key', e.target.value)}
                    />
                    <Input
                      className="w-24 bg-surface-input border-text-dim text-text text-[12px]"
                      value={p.value}
                      placeholder="参数值"
                      onChange={(e) => updateParam(i, 'value', e.target.value)}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-text-secondary hover:text-status-error hover:bg-transparent"
                      onClick={() => removeParam(i)}
                    >
                      ×
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="xs"
                  className="border-dashed border-text-dim text-text-secondary hover:border-accent hover:text-accent hover:bg-transparent"
                  onClick={addParam}
                >
                  + 添加参数
                </Button>
              </div>
            </div>

            <div className="flex gap-2 mt-3.5">
              <Button
                onClick={handleEditorSave}
                disabled={editorState.mode !== 'normal' && !editorName.trim()}
              >
                保存
              </Button>
              <Button variant="outline" onClick={handleEditorCancel}>
                取消
              </Button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
