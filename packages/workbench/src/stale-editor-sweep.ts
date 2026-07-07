/**
 * Close restored editor tabs that point at files absent from the mounted
 * workspace.
 *
 * The workbench's persisted storage is keyed by origin + the constant
 * `file:///workspace` workspace identity, so every project served from the
 * same COI origin shares one editor-state memento. After a project switch the
 * new workbench restores the previous project's tabs; files missing from the
 * new mirror render the permanent "The editor could not be opened because the
 * file was not found" placeholder (the placeholder only self-heals on a file
 * ADDED/UPDATED event, which never fires for a file the mirror doesn't
 * contain). Sweeping once after workspace population enforces the invariant:
 * every kept tab references a file that exists. Tabs whose files DO exist are
 * left alone — same-project restores keep their tabs, and their content
 * refresh rides the mirror's own write events.
 */

export interface UriLike {
  scheme: string
  path: string
}

export interface TabLike {
  isDirty: boolean
  input: unknown
}

export interface TabGroupsLike<T extends TabLike = TabLike> {
  all: ReadonlyArray<{ tabs: ReadonlyArray<T> }>
  close(tabs: T[]): Thenable<boolean>
}

export interface CloseStaleWorkspaceEditorsOptions<T extends TabLike = TabLike> {
  /** `vscode.window.tabGroups`-shaped surface holding the restored tabs. */
  tabGroups: TabGroupsLike<T>
  /** The `vscode.TabInputText` constructor — the instanceof discriminator for plain text tabs. */
  TabInputText: new (...args: never[]) => { uri: UriLike }
  /** The workspace folder root (e.g. `{ scheme: 'file', path: '/workspace' }`). */
  workspaceRoot: UriLike
  /** Probe whether a tab's file exists in the populated workspace filesystem. */
  exists: (uri: UriLike) => Promise<boolean>
}

/** Path-boundary containment: `/workspace/x` is inside `/workspace`, `/workspace2/x` is not. */
function isInsideRoot(uri: UriLike, root: UriLike): boolean {
  if (uri.scheme !== root.scheme) return false
  const rootPath = root.path.endsWith('/') ? root.path.slice(0, -1) : root.path
  return uri.path === rootPath || uri.path.startsWith(`${rootPath}/`)
}

/**
 * Sweep every tab group and close the clean text tabs whose workspace file no
 * longer exists. Dirty tabs are never closed (unsaved edits win over
 * consistency), non-text tab inputs are never touched, and a failing `exists`
 * probe keeps its tab — a broken probe must not destroy editor state.
 * Returns the number of tabs closed.
 */
export async function closeStaleWorkspaceEditors<T extends TabLike>(
  options: CloseStaleWorkspaceEditorsOptions<T>,
): Promise<number> {
  const { tabGroups, TabInputText, workspaceRoot, exists } = options

  const candidates: Array<{ tab: T; uri: UriLike }> = []
  for (const group of tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.isDirty) continue
      if (!(tab.input instanceof TabInputText)) continue
      const uri = tab.input.uri
      if (!isInsideRoot(uri, workspaceRoot)) continue
      candidates.push({ tab, uri })
    }
  }

  const stale: T[] = []
  await Promise.all(
    candidates.map(async ({ tab, uri }) => {
      try {
        if (!(await exists(uri))) stale.push(tab)
      } catch {
        // Probe failure: existence is unknown, so the tab stays.
      }
    }),
  )

  if (stale.length === 0) return 0
  await tabGroups.close(stale)
  return stale.length
}
