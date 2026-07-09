/**
 * Directory segment names that are NEVER mini-app source and must be skipped by
 * every project-tree scan, at any depth. The drift-proof CORE shared by the
 * devkit recompile watcher (createProjectWatcher) and the devtools editor
 * mirror (project-fs `SKIP_DIRS`, which derives its set from this one): the
 * `node_modules` omission that once made `watcher.close()` take 2.6s can never
 * regress in just one of them.
 *
 * Deliberately minimal — build-tool OUTPUT names (`dist`, `build`, `.next`,
 * tool caches …) are intentionally absent: app.json may declare pages under
 * such paths (e.g. `pages/build/index`), so the recompile watcher must still
 * see edits to them. Hiding build output is the devtools editor mirror's own
 * concern, layered ON TOP of this core (see project-fs `SKIP_DIRS`). Each side
 * also keeps its domain rule: the devkit watcher additionally drops all
 * dotfiles (they never affect compilation).
 */
export const WATCH_IGNORE_DIRS: ReadonlySet<string> = new Set([
	'node_modules', '.git', '.svn', '.hg',
])
