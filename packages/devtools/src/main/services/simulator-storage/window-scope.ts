/**
 * Window-ownership judgment for simulator webContents discovery.
 *
 * The workbench runs one `setupSimulatorStorage` instance per project
 * window, but Electron's `webContents`/`app.on('web-contents-created')`
 * APIs are process-global — every instance sees every window's webviews.
 * Without this filter, whichever instance's scan/callback fires first wins
 * the simulator it finds, so opening a second project window can steal the
 * first window's already-attached simulator (its Storage panel then reads
 * and writes the second project's partition).
 *
 * The ownership rule itself (does a webContents sit inside a window's own
 * renderer, its `contentView` tree, or a `<webview>` guest embedded in
 * either) is shared with dimina-electron-runtime's bridge router, which
 * faces the identical process-global-vs-per-window problem for its IPC
 * routing — so it's owned by @dimina-kit/electron-deck/main and re-exported
 * here under the name this package's callers expect.
 */
export { windowHostsWebContents } from '@dimina-kit/electron-deck/main'
