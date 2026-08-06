/**
 * Decide and emit the post-rebuild status for one completed rebuild.
 *
 * Explicit rebuild (`info.explicit` — the 重新编译 button, via
 * `session.rebuild()`): the renderer's own relaunch drives a hard re-attach
 * once the rebuild IPC resolves, and that re-attach is the run's ONLY
 * reflection. Emitting `hotReload: true` here as well would race a soft
 * reload against it — the two arrive through different channels with no
 * ordering guarantee, so the soft reload can land AFTER the hard re-attach
 * and drag the simulator back to the drifted page. The style fast path is a
 * soft-update path too and is skipped for the same reason.
 *
 * Watcher rebuild (explicit absent/false) — style-only fast path: hot-swap the
 * render-host stylesheets in place instead of respawning the DeviceShell —
 * page stack / form state / scroll / focus survive (no jitter, no focus
 * steal); `hotReload: false` keeps the renderer from bumping its reload token
 * (the respawn signal). Falls through to the full reload when the swap can't
 * run (no live render guest yet) so an edit is never dropped.
 *
 * `getProjectPages` never throws; empty pages are withheld so the renderer
 * keeps its previous launch dropdown.
 */
export function reportRebuildStatus(
	info: { styleOnly?: boolean; explicit?: boolean } | undefined,
	deps: {
		projectPath: string
		repo: { getProjectPages: (p: string) => { pages: string[] } }
		autoReload: boolean
		refreshSimulatorStyles: () => boolean
		sendStatus: (status: string, message: string, hotReload?: boolean, pages?: string[]) => void
	},
): void {
	const { pages } = deps.repo.getProjectPages(deps.projectPath)
	const pageList = pages.length ? pages : undefined
	if (info?.explicit) {
		deps.sendStatus('ready', '编译完成', false, pageList)
		return
	}
	if (info?.styleOnly && deps.autoReload && deps.refreshSimulatorStyles()) {
		deps.sendStatus('ready', '样式已热更新', false, pageList)
		return
	}
	deps.sendStatus('ready', deps.autoReload ? '编译完成，已重启' : '编译完成', deps.autoReload, pageList)
}
