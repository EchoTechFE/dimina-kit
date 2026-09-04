import fs from 'fs'
import path from 'path'
import type { CustomFileTypes, WorkbenchAppConfig } from '../../shared/types.js'
import type { ViewManager } from '../services/views/view-manager.js'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'
import type { DisposableRegistry } from '@dimina-kit/electron-deck/main'
import { devtoolsPackageRoot } from '../utils/paths.js'
import { startWorkbenchCoiServer } from '../services/workbench-coi-server.js'

/** Narrow view of the context fields the embedded editor depends on. */
export interface EditorViewContext {
  workspace: WorkspaceService
  fileTypes: CustomFileTypes
  views: ViewManager
  registry: DisposableRegistry
}

/**
 * Embedded workbench editor — the sole devtools editor. Stands up the COI http
 * server that serves the workbench bundle with the SharedArrayBuffer isolation
 * headers and bridges `/__fs/*` onto the active project, then hands its base URL
 * to the view manager so the 'editor' dock slot mounts the workbench
 * WebContentsView. Both the server and the WCV tear down with the context
 * registry.
 */
export async function setupEditorView(
  config: WorkbenchAppConfig,
  context: EditorViewContext,
  getActiveAppId: () => string | null,
): Promise<void> {
  // Default the bundle dir to the devtools package's OWN `dist/vscode-workbench`
  // (resolved from the package root), NOT relative to the caller's rendererDir:
  // a host that overrides `rendererDir` but omits `editorViewConfig.bundleDir`
  // would otherwise compute a path next to ITS renderer, where no workbench
  // bundle exists → 404 / blank editor.
  const bundleDir =
    config.editorViewConfig?.bundleDir ?? path.join(devtoolsPackageRoot, 'dist/vscode-workbench')
  // Skip the entire editor assembly when the bundle is missing. Starting the COI
  // server and attaching the WCV against a non-existent bundle yields a silent
  // blank editor (the WCV loads index.html → 404); a launchable app with no
  // editor is strictly better. The view manager never gets a source, so the
  // 'editor' slot's lazy attach is a no-op.
  if (!fs.existsSync(path.join(bundleDir, 'index.html'))) {
    console.warn(
      `[workbench] editor bundle not found at ${bundleDir} — skipping embedded editor assembly`,
    )
    return
  }

  const coiServer = await startWorkbenchCoiServer({
    rootDir: bundleDir,
    getProjectRoot: () => context.workspace.getProjectPath(),
    extensionsDir: config.editorViewConfig?.extensionsDir,
    getFileTypes: () => context.fileTypes,
    // Names the editor's VS Code workspace after the active miniapp, so each
    // project gets its own open-editors/view-state bucket instead of all of
    // them sharing the one derived from the constant mirror root.
    getProjectIdentity: () => ({
      appId: getActiveAppId(),
      projectPath: context.workspace.getProjectPath(),
    }),
  })
  try {
    // Return the close promise so the registry awaits server shutdown on dispose
    // instead of fire-and-forgetting it (a dangling http server would keep the
    // port + event loop alive past teardown).
    context.registry.add(() => coiServer.close())
    // The registry disposes LIFO, so this runs BEFORE the context-level
    // disposeAll: void any in-flight open's attach hold here too, or a stale
    // release / cap firing could rebuild the workbench during the awaited
    // coiServer.close() above, before disposeAll's own cancel runs.
    context.registry.add(() => {
      context.views.cancelWorkbenchAttachHold()
      context.views.detachWorkbench()
    })
  } catch (err) {
    // The window was torn down while the bridge was still binding, so the
    // registry that would have closed it is already disposed and refuses new
    // entries. Close it here instead: an orphaned route keeps the shared COI
    // listener (and its port) alive for the rest of the process.
    await coiServer.close().catch(() => {})
    throw err
  }
  // Only HAND the view manager the COI URL — do NOT load yet. The heavy
  // WebContentsView load (10MB bundle + ext-host) is deferred to the first time
  // the 'editor' dock slot becomes visible (first non-zero bounds), so it never
  // sits on the app boot critical path. Loading it eagerly here delayed
  // preload/window-ready enough to trip the e2e launch health check.
  context.views.setWorkbenchSource(coiServer.baseUrl)
}
