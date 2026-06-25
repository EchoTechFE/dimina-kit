import { EditorChannel, type EditorOpenFilePayload } from '../../../shared/ipc-channels'
import { on } from './ipc-transport'

/**
 * Subscribe to "open this file in the editor" requests from the main process.
 * The defensive renderer-side leg of the "click a console file link → open in
 * editor" pipeline: the embedded DevTools front-end routes a source-link click
 * to main, which prefers revealing the file directly in the workbench WCV
 * (`openFileInWorkbench`) and only broadcasts here when that view is unavailable.
 *
 * Returns an unsubscribe function (removeListener contract).
 */
export function onEditorOpenFile(
  handler: (payload: EditorOpenFilePayload) => void,
): () => void {
  // Best-effort: this is a passive UI subscription mounted with the editor. If
  // the preload bridge isn't present (e.g. the editor renders before the bridge
  // is exposed, or in a non-Electron test harness), don't crash the editor —
  // just yield a no-op unsubscribe. A real missing-bridge bug still surfaces via
  // the load-bearing `invoke`/`send` paths that throw.
  try {
    return on<[EditorOpenFilePayload]>(EditorChannel.OpenFile, (payload) => handler(payload))
  } catch {
    return () => {}
  }
}
