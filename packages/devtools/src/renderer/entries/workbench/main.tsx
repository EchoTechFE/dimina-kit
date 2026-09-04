import { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import '../../design.css'
import { ProjectRuntime } from '@/modules/main/features/project-runtime/project-runtime'
import type { Project } from '@/shared/types'
import { ensurePlacementGenerationSeeded } from '../../shared/renderer-placement-generation'

/** Surface a fatal boot failure without mounting React — see the `.catch()` below. */
function renderFatalStartupError(err: unknown): void {
  console.error('[devtools] fatal: could not allocate a placement-generation seed before first render', err)
  const root = document.getElementById('root')
  if (root) root.textContent = 'Dimina DevTools failed to start. Please restart the app.'
}

/**
 * Each project window's identity comes entirely from its URL — main opens it
 * with `?path=…&name=…` (see WindowChannel.OpenProjectWindow) rather than
 * pushing the record over IPC, so a freshly-created window can render
 * synchronously off `location.search` without waiting on a round-trip.
 * `name` falls back to `path` so a malformed/missing name never blanks the
 * title bar.
 */
function parseProjectFromQuery(): Project | null {
  const params = new URLSearchParams(location.search)
  const path = params.get('path')
  if (!path) return null
  return { name: params.get('name') || path, path }
}

function MissingProjectError() {
  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      无法打开项目：窗口地址缺少 path 参数。请关闭此窗口并从项目列表重新打开。
    </div>
  )
}

function WorkbenchApp({ project }: { project: Project | null }) {
  useEffect(() => {
    if (project) document.title = project.name
  }, [project])

  if (!project) return <MissingProjectError />
  return <ProjectRuntime project={project} />
}

// See entries/main/main.tsx for why the placement-generation seed must be
// resolved before the first render — the same invariant applies here since
// ProjectRuntime draws from the same shared generation sequence
// (renderer-placement-generation.ts) as the list window.
const project = parseProjectFromQuery()

ensurePlacementGenerationSeeded()
  .then(() => {
    ReactDOM.createRoot(document.getElementById('root')!).render(<WorkbenchApp project={project} />)
  })
  .catch(renderFatalStartupError)
