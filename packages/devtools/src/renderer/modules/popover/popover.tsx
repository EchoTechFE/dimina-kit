import React, { useState, useEffect } from 'react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Select } from '@/shared/components/ui/select'
import { DEFAULT_SCENE } from '../../../shared/constants'
import { POPOVER_WIDTH_PX, POPOVER_MARGIN_PX } from '../../shared/constants'
import { emitPopoverRelaunch, hidePopover, onPopoverInit } from '@/shared/api'
import type { CompileConfig } from '../../shared/types'

export default function Popover() {
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const [config, setConfig] = useState<CompileConfig>({
    startPage: '',
    scene: DEFAULT_SCENE,
    queryParams: [],
  })
  const [pages, setPages] = useState<string[]>([])

  useEffect(() => {
    return onPopoverInit((data) => {
      setPages(data.pages)
      setConfig(data.config)
      const maxLeft = window.innerWidth - POPOVER_WIDTH_PX - POPOVER_MARGIN_PX
      setPosition({ top: data.top, left: Math.min(data.left, maxLeft) })
    })
  }, [])

  function handleOverlayClick() {
    void hidePopover()
  }

  function addParam() {
    setConfig((c) => ({
      ...c,
      queryParams: [...c.queryParams, { key: '', value: '' }],
    }))
  }

  function removeParam(idx: number) {
    setConfig((c) => ({
      ...c,
      queryParams: c.queryParams.filter((_, i) => i !== idx),
    }))
  }

  function updateParam(idx: number, field: 'key' | 'value', value: string) {
    setConfig((c) => {
      const next = [...c.queryParams]
      const prev = next[idx] ?? { key: '', value: '' }
      next[idx] = { ...prev, [field]: value }
      return { ...c, queryParams: next }
    })
  }

  function handleRelaunch() {
    emitPopoverRelaunch(config)
  }

  return (
    <>
      <div
        className="fixed inset-0"
        onClick={handleOverlayClick}
      />

      <div
        className="fixed w-[340px] bg-surface border border-border-strong rounded-md p-3.5 shadow-[0_8px_24px_var(--color-overlay-heavy)] z-10"
        style={{ top: position.top, left: position.left }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 mb-3">
          <label className="w-16 shrink-0 text-code-label text-[12px]">
            启动页面
          </label>
          <Select
            className="flex-1 min-w-0 bg-surface-input border-text-dim text-text text-[12px] py-0.5"
            value={config.startPage}
            onChange={(e) =>
              setConfig((c) => ({ ...c, startPage: e.target.value }))
            }
          >
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
            value={config.scene}
            onChange={(e) =>
              setConfig((c) => ({
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
            {config.queryParams.map((p, i) => (
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

        <div className="mt-3.5">
          <Button onClick={handleRelaunch}>▶ 重新编译</Button>
        </div>
      </div>
    </>
  )
}
