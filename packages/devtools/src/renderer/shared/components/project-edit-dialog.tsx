/**
 * "编辑项目" dialog. Edits the display fields of an already-imported project:
 * its name and its card icon.
 *
 * The directory is shown but not editable. It is the identity of the record —
 * every other per-project store (compile config, thumbnail, file watcher) is
 * keyed by it — so re-pointing an existing record at another directory is an
 * import, not an edit. Showing it read-only still answers the question the
 * user opened the dialog with ("which project is this?").
 *
 * Renders nothing when `open` is false so the parent can mount it
 * unconditionally.
 */
import * as React from 'react'
import { useEffect, useState } from 'react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/shared/components/ui/dialog'
import type { Project, ProjectPatch } from '../types'

export interface ProjectEditDialogProps {
  open: boolean
  /** The record being edited; `null` while the dialog is closed. */
  project: Project | null
  onSubmit: (patch: ProjectPatch) => void
  onCancel: () => void
}

export function ProjectEditDialog(
  props: ProjectEditDialogProps,
): React.ReactElement | null {
  const { open, project, onSubmit, onCancel } = props
  const [name, setName] = useState('')
  const [iconUrl, setIconUrl] = useState('')

  // Re-seed from the record every time the dialog opens on a project, so a
  // cancelled edit never leaks into the next one. Keyed on the project's path
  // (its identity) as well as `open`: opening the dialog on a different card
  // without an intervening close must not keep the previous card's values.
  // The fields are read into locals so the effect depends on those values and
  // not on the record's identity — a re-rendered parent handing down an equal
  // but freshly built `project` object must not wipe what the user is typing.
  const projectPath = project?.path
  const projectName = project?.name
  const projectIconUrl = project?.iconUrl
  useEffect(() => {
    if (!open || projectPath === undefined) return
    setName(projectName ?? '')
    setIconUrl(projectIconUrl ?? '')
  }, [open, projectPath, projectName, projectIconUrl])

  if (!open || !project) return null

  const trimmedName = name.trim()
  const canSubmit = trimmedName.length > 0

  function handleSubmit() {
    if (!canSubmit) return
    onSubmit({ name: trimmedName, iconUrl: iconUrl.trim() })
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent className="w-[480px] max-w-[calc(100vw-2rem)] gap-4 p-5">
        <DialogHeader>
          <DialogTitle>编辑项目</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Hints sit outside the <label> so they don't become part of the
              field's accessible name. */}
          <div className="flex flex-col gap-1.5">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm text-text-secondary">项目名称</span>
              <Input
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSubmit()
                }}
              />
            </label>
            <span className="text-xs text-text-dim">
              会写入项目目录下的 project.private.config.json
            </span>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-text-secondary">图标地址</span>
            <Input
              value={iconUrl}
              placeholder="https://… ，留空则显示项目名首字母"
              onChange={(e) => setIconUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmit()
              }}
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm text-text-secondary">项目目录</span>
              <Input
                value={project.path}
                readOnly
                disabled
                title={project.path}
                className="cursor-default text-text-secondary"
              />
            </label>
            <span className="text-xs text-text-dim">
              目录不可修改。要换目录请重新导入。
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
