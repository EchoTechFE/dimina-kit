/**
 * Built-in "新建项目" dialog. Two independent inputs (项目名 + 目录) plus a
 * template-card grid. Renders nothing when `open` is false so the parent
 * can mount it unconditionally.
 *
 * The directory field is *suggested* from the project name + a base
 * directory (last-used parent, or platform default). It stays in sync with
 * the name until the user manually edits the path or picks a directory
 * with 浏览; from then on it's pinned and stops following the name.
 */
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'

export interface ProjectTemplateInfo {
  id: string
  name: string
  description?: string
}

export interface ProjectCreateDialogProps {
  open: boolean
  templates: ProjectTemplateInfo[]
  /**
   * Parent directory used to compose the suggested target path. If empty,
   * the dialog suggests just the project-name slug (the user must point
   * 浏览 at a real location). Provide an absolute path on macOS/Linux.
   */
  defaultBaseDir?: string
  onSubmit: (input: {
    name: string
    path: string
    templateId: string
  }) => void
  onCancel: () => void
  onBrowse: () => Promise<string | null>
}

/**
 * Project-name → directory-name. Strips characters that aren't safe in a
 * filesystem segment on the common platforms (macOS/Linux/Windows). Keeps
 * CJK and unicode letters; collapses whitespace and runs of separators.
 */
export function slugifyDirName(name: string): string {
  return name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
}

function joinBase(base: string, leaf: string): string {
  if (!leaf) return ''
  if (!base) return leaf
  return base.endsWith('/') ? `${base}${leaf}` : `${base}/${leaf}`
}

export function ProjectCreateDialog(
  props: ProjectCreateDialogProps,
): React.ReactElement | null {
  const { open, templates, defaultBaseDir, onSubmit, onCancel, onBrowse } = props
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [templateId, setTemplateId] = useState<string>(
    templates[0]?.id ?? 'blank',
  )
  // `path` keeps following `name` until the user edits the path directly
  // (typing or 浏览). The ref avoids re-renders that an extra state would
  // cause when name changes rapidly.
  const manualPathRef = useRef(false)

  // Re-seed the default template selection whenever the supplied catalog
  // changes (e.g. host injected a new list). If the current selection is
  // still in the list, keep it; otherwise fall back to the first.
  useEffect(() => {
    if (!templates.find((t) => t.id === templateId)) {
      setTemplateId(templates[0]?.id ?? 'blank')
    }
  }, [templates, templateId])

  // Reset to a clean slate every time the dialog opens so the previous
  // session's inputs don't bleed through.
  useEffect(() => {
    if (open) {
      setName('')
      setPath('')
      manualPathRef.current = false
    }
  }, [open])

  if (!open) return null

  const canSubmit = name.trim().length > 0 && path.trim().length > 0

  function handleNameChange(next: string) {
    setName(next)
    if (!manualPathRef.current) {
      const slug = slugifyDirName(next)
      setPath(slug ? joinBase(defaultBaseDir ?? '', slug) : '')
    }
  }

  function handlePathChange(next: string) {
    manualPathRef.current = true
    setPath(next)
  }

  async function handleBrowse() {
    const picked = await onBrowse()
    if (picked) {
      manualPathRef.current = true
      setPath(picked)
    }
  }

  function handleSubmit() {
    if (!canSubmit) return
    onSubmit({ name: name.trim(), path: path.trim(), templateId })
  }

  return (
    <div
      role="dialog"
      aria-label="新建项目"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div className="bg-surface rounded-lg shadow-lg w-[560px] max-w-[90vw] p-6">
        <h2 className="text-base font-semibold text-text-white mb-4">新建项目</h2>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-secondary">项目名</span>
            <input
              aria-label="项目名"
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="My App"
              className="h-8 px-2 rounded-md border border-border bg-bg text-sm text-text-white"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-secondary">目录</span>
            <div className="flex gap-2">
              <input
                aria-label="目录"
                type="text"
                value={path}
                onChange={(e) => handlePathChange(e.target.value)}
                placeholder="/absolute/path/to/dir"
                className="flex-1 h-8 px-2 rounded-md border border-border bg-bg text-sm text-text-white"
              />
              <button
                type="button"
                onClick={handleBrowse}
                className="px-3 h-8 rounded-md border border-border text-sm text-text-secondary hover:text-text-white"
              >
                浏览
              </button>
            </div>
          </label>

          <div className="flex flex-col gap-1 text-sm">
            <span className="text-text-secondary">模板</span>
            <div
              className="grid gap-2"
              style={{
                gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              }}
            >
              {templates.map((t) => {
                const active = t.id === templateId
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTemplateId(t.id)}
                    className={[
                      'text-left p-3 rounded-md border',
                      active
                        ? 'border-accent text-text-white bg-accent/10'
                        : 'border-border text-text-secondary hover:border-accent',
                    ].join(' ')}
                    aria-pressed={active}
                  >
                    <div className="text-sm font-medium">{t.name}</div>
                    {t.description ? (
                      <div className="text-[11px] mt-1 text-text-dim">
                        {t.description}
                      </div>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 h-8 rounded-md border border-border text-sm text-text-secondary hover:text-text-white"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-3 h-8 rounded-md text-sm bg-accent text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            创建
          </button>
        </div>
      </div>
    </div>
  )
}
