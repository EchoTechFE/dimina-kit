import React, { useState, useEffect, useRef } from 'react'
import { POPOVER_WIDTH_PX, POPOVER_MARGIN_PX } from '../../shared/constants'
import { applyPopoverCommand, hidePopover, notifyOverlayReady, onPopoverInit } from '@/shared/api'
import type { CompileMode, CompileModeCommand, CompileModeId, CompileModeState } from '../../shared/types'
import { routeToMode } from '../../../shared/compile-modes'
import { emptyCompileModeState } from '../../../shared/compile-mode-state'
import { CompileModeMenu } from './compile-mode-menu'
import { CompileModeDialog } from './compile-mode-dialog'

/**
 * The popover is either picking a mode or editing one. Picking is the anchored
 * menu; editing opens a centered dialog over it, so the menu stays as context
 * and the form is free to be as tall as its parameter rows need. `id` is the
 * entry being edited, `null` for a mode that doesn't exist yet.
 */
type View =
  | { kind: 'menu' }
  | { kind: 'form'; title: string; id: CompileModeId | null; mode: CompileMode }

/** A new mode starts named after its page, so 确定 is reachable in one click. */
function defaultModeName(pathName: string): string {
  return pathName.split('/').filter(Boolean).pop() ?? ''
}

export default function Popover() {
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const [state, setState] = useState<CompileModeState>(emptyCompileModeState())
  const [pages, setPages] = useState<string[]>([])
  const [entryPagePath, setEntryPagePath] = useState('')
  const [currentRoute, setCurrentRoute] = useState('')
  const [view, setView] = useState<View>({ kind: 'menu' })

  // Latest anchor from the init payload, kept for re-clamping. The overlay
  // view's bounds are applied only AFTER main's markReady (readyMode manual),
  // so the first `onPopoverInit` can arrive while `window.innerWidth` is still
  // 0 — `maxLeft` then goes negative and the panel is clamped off-screen. When
  // the view gains its size the resize event fires; re-apply the same anchor
  // against the real viewport instead of leaving the panel stranded.
  const initRef = useRef<{ top: number; left: number } | null>(null)

  useEffect(() => {
    function applyPosition(data: { top: number; left: number }): void {
      const maxLeft = window.innerWidth - POPOVER_WIDTH_PX - POPOVER_MARGIN_PX
      setPosition({ top: data.top, left: Math.min(data.left, maxLeft) })
    }

    const off = onPopoverInit((data) => {
      setPages(data.pages)
      setState(data.state)
      setEntryPagePath(data.entryPagePath)
      setCurrentRoute(data.currentRoute)
      // The popover view is reused across openings, so a previous session's
      // half-finished form must not be what the user sees next time.
      setView({ kind: 'menu' })
      initRef.current = { top: data.top, left: data.left }
      applyPosition(initRef.current)
    })

    const onResize = (): void => {
      if (initRef.current) applyPosition(initRef.current)
    }
    window.addEventListener('resize', onResize)

    notifyOverlayReady()
    return () => {
      off()
      window.removeEventListener('resize', onResize)
    }
  }, [])

  // Sole call site of `applyPopoverCommand`. When main's Apply handler
  // rejects (e.g. a failed persist), it already broadcasts
  // `compileModesApplyFailed` and the main window shows it — by the time
  // that happens this popover has already been closed (every command dispatch
  // is followed by hiding the menu), so there is nowhere here to surface the
  // error. Swallowing the rejection is deliberate: an unhandled `catch` would
  // just turn it into an unhandled rejection in the popover's own window.
  function dispatch(command: CompileModeCommand): void {
    applyPopoverCommand(command).catch(() => {})
  }

  function handleSelect(id: CompileModeId | null) {
    dispatch({ type: 'select', id })
  }

  function handleEdit(id: CompileModeId) {
    const mode = state.entries.find((entry) => entry.id === id)?.mode
    if (!mode) return
    setView({ kind: 'form', title: '编辑编译模式', id, mode })
  }

  function handleCreate() {
    setView({
      kind: 'form',
      title: '添加编译模式',
      id: null,
      mode: {
        name: defaultModeName(entryPagePath),
        pathName: entryPagePath,
        query: '',
        scene: null,
      },
    })
  }

  function handleCreateFromCurrentPage() {
    const seeded = routeToMode(currentRoute, '')
    setView({
      kind: 'form',
      title: '以当前页面新建',
      id: null,
      mode: { ...seeded, name: defaultModeName(seeded.pathName) },
    })
  }

  function handleSubmit(mode: CompileMode) {
    if (view.kind !== 'form') return
    dispatch(view.id === null ? { type: 'add', mode } : { type: 'update', id: view.id, mode })
  }

  function handleDelete() {
    if (view.kind !== 'form' || view.id === null) return
    dispatch({ type: 'remove', id: view.id })
  }

  return (
    <>
      <div className="fixed inset-0" onClick={() => void hidePopover()} />

      <div
        className="fixed w-[340px] bg-surface border border-border-strong rounded-md p-3.5 shadow-[0_8px_24px_var(--color-overlay-heavy)] z-10"
        style={{ top: position.top, left: position.left }}
        onClick={(e) => e.stopPropagation()}
      >
        <CompileModeMenu
          state={state}
          entryPagePath={entryPagePath}
          currentRoute={currentRoute}
          onSelect={handleSelect}
          onEdit={handleEdit}
          onCreate={handleCreate}
          onCreateFromCurrentPage={handleCreateFromCurrentPage}
        />
      </div>

      {view.kind === 'form' && (
        <CompileModeDialog
          title={view.title}
          mode={view.mode}
          pages={pages}
          canDelete={view.id !== null}
          onSubmit={handleSubmit}
          onCancel={() => setView({ kind: 'menu' })}
          onDelete={handleDelete}
        />
      )}
    </>
  )
}
