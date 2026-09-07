import React, { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Input } from '@/shared/components/ui/input'
import { Select } from '@/shared/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import type { CompileMode } from '@/shared/types'
import { DEFAULT_SCENE } from '../../../shared/constants'
import {
  parseQueryString,
  stringifyQueryParams,
} from '../../../shared/compile-modes'

interface CompileModeDialogProps {
  title: string
  /** Seed values; the dialog owns its state from mount on. */
  mode: CompileMode
  pages: string[]
  /** False for a mode being created — there is nothing to delete yet. */
  canDelete: boolean
  onSubmit: (mode: CompileMode) => void
  onCancel: () => void
  onDelete: () => void
}

type ParamView = 'rows' | 'raw'

/**
 * One labelled field. Fields with a single control wrap it in a `<label>` so
 * the caption is the control's accessible name; 启动参数 has several controls
 * and gets a plain heading instead.
 */
function Field(props: {
  label: string
  /** Stable handle for tests, independent of the caption's wording. */
  field: string
  hint?: string
  labelled?: boolean
  children: React.ReactNode
}) {
  const { label, field, hint, labelled = true, children } = props
  const Wrapper = labelled ? 'label' : 'div'
  return (
    <div className="flex flex-col gap-1.5" data-testid="compile-mode-field" data-field={field}>
      <Wrapper className="flex flex-col gap-1.5">
        <span className="text-sm text-text-secondary">{label}</span>
        {children}
      </Wrapper>
      {hint && <span className="text-xs text-text-dim">{hint}</span>}
    </div>
  )
}

/**
 * Editor for one compile mode.
 *
 * A centered dialog rather than a second face of the dropdown: picking a mode
 * is a one-click menu action, editing one is a form whose height follows the
 * number of parameter rows. Sharing the dropdown's 340px anchored card made
 * the second grow out of the first.
 *
 * The raw `query` string is the authoritative value: it is what gets stored and
 * what WeChat's own config file holds. 逐条 is a parsed VIEW of it, and only an
 * actual row edit re-serializes the whole string — so a hand-written
 * `a=1&b` survives being looked at in 逐条 instead of coming back as `a=1&b=`.
 */
export function CompileModeDialog(props: CompileModeDialogProps) {
  const { title, mode, pages, canDelete, onSubmit, onCancel, onDelete } = props

  const [name, setName] = useState(mode.name)
  const [pathName, setPathName] = useState(mode.pathName)
  const [query, setQuery] = useState(mode.query)
  const [rows, setRows] = useState(() => parseQueryString(mode.query))
  const [paramView, setParamView] = useState<ParamView>('rows')
  const [scene, setScene] = useState(mode.scene)

  function showRows() {
    // Re-derive from the authoritative string: the user may have edited it raw.
    setRows(parseQueryString(query))
    setParamView('rows')
  }

  function commitRows(next: { key: string; value: string }[]) {
    setRows(next)
    setQuery(stringifyQueryParams(next))
  }

  function updateRow(idx: number, field: 'key' | 'value', value: string) {
    const next = [...rows]
    const prev = next[idx] ?? { key: '', value: '' }
    next[idx] = { ...prev, [field]: value }
    commitRows(next)
  }

  function submit() {
    onSubmit({
      ...mode,
      name: name.trim(),
      pathName,
      query,
      scene,
    })
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent className="w-[520px] max-w-[calc(100vw-2rem)] gap-4 p-5">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field label="模式名称" field="name">
            <Input
              value={name}
              autoFocus
              placeholder="未命名"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          <Field label="启动页面" field="pathName">
            <Select value={pathName} onChange={(e) => setPathName(e.target.value)}>
              {/* An empty pathName means "follow the app's entry page". It is
                  always offered, so a mode that once pointed at a concrete page
                  can be put back on the entry page — and so the select can show
                  this state instead of silently falling back to the first page. */}
              <option value="">默认为首页</option>
              {pathName && !pages.includes(pathName) && (
                <option value={pathName}>{pathName}（页面不存在）</option>
              )}
              {pages.map((pg) => (
                <option key={pg} value={pg}>
                  {pg}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="启动参数" field="params" labelled={false}>
            <Tabs
              variant="segment"
              value={paramView}
              onValueChange={(next) => {
                if (next === 'rows') showRows()
                else setParamView('raw')
              }}
            >
              <TabsList className="w-fit">
                <TabsTrigger value="rows">逐条</TabsTrigger>
                <TabsTrigger value="raw">原始串</TabsTrigger>
              </TabsList>

              <TabsContent value="rows" className="flex flex-col gap-2">
                {rows.map((p, i) => (
                  <div key={i} className="flex items-center gap-2" data-testid="compile-mode-param-row">
                    <Input
                      className="min-w-0 flex-1"
                      value={p.key}
                      placeholder="参数名"
                      onChange={(e) => updateRow(i, 'key', e.target.value)}
                    />
                    <Input
                      className="min-w-0 flex-1"
                      value={p.value}
                      placeholder="参数值"
                      onChange={(e) => updateRow(i, 'value', e.target.value)}
                    />
                    <Button
                      variant="danger"
                      size="icon-sm"
                      className="shrink-0"
                      aria-label={`删除参数 ${p.key || i + 1}`}
                      onClick={() => commitRows(rows.filter((_, j) => j !== i))}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-fit gap-1.5 px-2 text-text-secondary"
                  // A blank row is not a parameter yet, so it is kept in the view
                  // only — `stringifyQueryParams` drops it until it gets a name.
                  onClick={() => setRows([...rows, { key: '', value: '' }])}
                >
                  <Plus className="size-3.5" />
                  添加参数
                </Button>
              </TabsContent>

              <TabsContent value="raw" className="flex flex-col gap-1.5">
                <Input
                  className="font-mono"
                  value={query}
                  placeholder="a=1&b=2"
                  onChange={(e) => setQuery(e.target.value)}
                />
                <span className="text-xs text-text-dim">URL 查询串，不含开头的 ?</span>
              </TabsContent>
            </Tabs>
          </Field>

          <Field
            label="进入场景"
            field="scene"
            hint={`留空则使用默认场景值 ${DEFAULT_SCENE}`}
          >
            <Input
              type="number"
              className="w-32"
              value={scene ?? ''}
              placeholder={String(DEFAULT_SCENE)}
              // Empty means "unset" — the mode then launches with the default
              // scene, which is also what WeChat stores for a mode left untouched.
              onChange={(e) =>
                setScene(e.target.value === '' ? null : Number(e.target.value))
              }
            />
          </Field>
        </div>

        <DialogFooter className="sm:justify-between">
          {canDelete ? (
            <Button
              variant="ghost"
              className="text-status-error hover:bg-[var(--qd-destructive-soft)]"
              onClick={onDelete}
            >
              删除模式
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onCancel}>
              取消
            </Button>
            <Button onClick={submit}>保存</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
