/**
 * Dimina-specific workbench sidebar, wired against the page-side `vscode` API.
 *
 * Contributes a dedicated Activity Bar container plus two TreeViews that read the
 * live project layout from `file:///workspace/app.json` (the disk project mirror).
 * Nothing here hardcodes the dimina submodule layout — the page list is derived
 * at runtime from `pages` + `subPackages[].pages` via `vscode.workspace.fs`.
 *
 * Two-part contract, matching the wxml-language-features shape:
 *   - `DIMINA_SIDEBAR_MANIFEST` + `diminaSidebarFileUrls()` declare the Activity Bar
 *     container + view ids so the workbench renders the container/icon. These are
 *     consumed at extension-registration time (registerExtension + registerFileUrl).
 *   - `registerDiminaSidebar(api)` attaches the TreeDataProviders + the open-page
 *     command against the page-side vscode API (from the LocalProcess getApi()).
 *
 * The manifest's view container id and view ids must stay in sync with the ids the
 * TreeViews are created against here, or the views render in no container.
 */
import type * as vscode from 'vscode'

/** Activity Bar container id; the manifest view container and the workbench icon entry share it. */
export const DIMINA_VIEW_CONTAINER_ID = 'diminaSidebar'
/** Pages tree view id; must match the manifest `contributes.views` entry. */
export const DIMINA_PAGES_VIEW_ID = 'diminaPages'
/** App-config overview tree view id; must match the manifest `contributes.views` entry. */
export const DIMINA_APP_CONFIG_VIEW_ID = 'diminaAppConfig'
/** Command a Pages node fires on click to open its source file. */
export const DIMINA_OPEN_PAGE_COMMAND = 'dimina.openPage'

const WORKSPACE_FILE_ROOT = 'file:///workspace'

/**
 * Extension manifest contributing the Activity Bar container + the two views.
 * `icon` points to a file URL registered via `diminaSidebarFileUrls()`; the
 * codicon `$(extensions)` fallback keeps the entry visible even before the icon
 * asset resolves.
 */
export const DIMINA_SIDEBAR_MANIFEST = {
  name: 'dimina-sidebar',
  publisher: 'dimina',
  version: '1.0.0',
  engines: { vscode: '*' },
  contributes: {
    viewsContainers: {
      activitybar: [
        {
          id: DIMINA_VIEW_CONTAINER_ID,
          title: 'Dimina',
          icon: './dimina-activity.svg',
        },
      ],
    },
    views: {
      [DIMINA_VIEW_CONTAINER_ID]: [
        {
          id: DIMINA_PAGES_VIEW_ID,
          name: 'Pages',
        },
        {
          id: DIMINA_APP_CONFIG_VIEW_ID,
          name: 'App Config',
        },
      ],
    },
    commands: [
      {
        command: DIMINA_OPEN_PAGE_COMMAND,
        title: 'Dimina: Open Page Source',
      },
    ],
  },
}

/** Activity Bar icon (a simple dimina-mark glyph), served offline as a blob URL. */
const DIMINA_ACTIVITY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">
  <rect x="3" y="3" width="7" height="7" rx="1.5" fill="currentColor"/>
  <rect x="14" y="3" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.6"/>
  <rect x="3" y="14" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.6"/>
  <rect x="14" y="14" width="7" height="7" rx="1.5" fill="currentColor"/>
</svg>`

function svgBlobUrl(svg: string): string {
  return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
}

/**
 * File URLs the manifest references (the Activity Bar icon), to feed
 * `registerFileUrl` after `registerExtension`. Keyed by manifest-relative path.
 */
export function diminaSidebarFileUrls(): Array<{ path: string; url: string; mimeType: string }> {
  return [
    {
      path: './dimina-activity.svg',
      url: svgBlobUrl(DIMINA_ACTIVITY_SVG),
      mimeType: 'image/svg+xml',
    },
  ]
}

interface AppJson {
  pages?: string[]
  subPackages?: Array<{ root?: string; pages?: string[] }>
  // The MINA spec also allows `subpackages` (lowercase).
  subpackages?: Array<{ root?: string; pages?: string[] }>
  window?: Record<string, unknown>
  tabBar?: {
    list?: Array<{ pagePath?: string; text?: string }>
    [k: string]: unknown
  }
}

/** A resolved page entry: its app.json path string + the on-disk root prefix it came from. */
interface PageEntry {
  /** Full page path relative to the workspace root, e.g. `page/component/pages/view/view`. */
  fullPath: string
  /** Sub-package root (`''` for main-package pages), used purely for grouping in the tree. */
  group: string
}

/** Candidate source extensions for a page, in open-preference order. */
const PAGE_SOURCE_EXTENSIONS = ['.qml', '.wxml', '.js', '.ts', '.json'] as const

/**
 * Node kinds the Pages tree renders. `group` nodes only appear when sub-packages
 * exist (the main package's pages sit at the root for a flat, scan-friendly list).
 */
type PagesNode =
  | { kind: 'group'; group: string; label: string; pages: PageEntry[] }
  | { kind: 'page'; entry: PageEntry }

/** App Config overview nodes (read-only). */
type AppConfigNode =
  | { kind: 'section'; label: string; children: AppConfigNode[] }
  | { kind: 'leaf'; label: string; description?: string }

async function readAppJson(api: typeof vscode): Promise<AppJson | undefined> {
  const uri = api.Uri.parse(`${WORKSPACE_FILE_ROOT}/app.json`)
  try {
    const bytes = await api.workspace.fs.readFile(uri)
    const text = new TextDecoder().decode(bytes)
    return JSON.parse(text) as AppJson
  } catch {
    return undefined
  }
}

/** Flatten app.json `pages` + `subPackages[].pages` into grouped, full-path entries. */
function collectPages(app: AppJson): PageEntry[] {
  const out: PageEntry[] = []
  for (const p of app.pages ?? []) {
    out.push({ fullPath: p, group: '' })
  }
  const subs = app.subPackages ?? app.subpackages ?? []
  for (const sub of subs) {
    const root = (sub.root ?? '').replace(/\/+$/, '')
    for (const p of sub.pages ?? []) {
      const fullPath = root ? `${root}/${p}` : p
      out.push({ fullPath, group: root })
    }
  }
  return out
}

/** Resolve the first existing source file for a page path, probing candidate extensions. */
async function resolvePageSourceUri(
  api: typeof vscode,
  fullPath: string,
): Promise<vscode.Uri | undefined> {
  for (const ext of PAGE_SOURCE_EXTENSIONS) {
    const uri = api.Uri.parse(`${WORKSPACE_FILE_ROOT}/${fullPath}${ext}`)
    try {
      await api.workspace.fs.stat(uri)
      return uri
    } catch {
      // try the next extension
    }
  }
  return undefined
}

class DiminaPagesProvider implements vscode.TreeDataProvider<PagesNode> {
  private readonly _onDidChange: vscode.EventEmitter<PagesNode | undefined | void>
  readonly onDidChangeTreeData: vscode.Event<PagesNode | undefined | void>

  constructor(private readonly api: typeof vscode) {
    this._onDidChange = new api.EventEmitter<PagesNode | undefined | void>()
    this.onDidChangeTreeData = this._onDidChange.event
  }

  refresh(): void {
    this._onDidChange.fire()
  }

  getTreeItem(node: PagesNode): vscode.TreeItem {
    const api = this.api
    if (node.kind === 'group') {
      const item = new api.TreeItem(node.label, api.TreeItemCollapsibleState.Expanded)
      item.iconPath = new api.ThemeIcon('package')
      item.description = `${node.pages.length}`
      item.contextValue = 'diminaPageGroup'
      return item
    }
    const label = pageLabel(node.entry)
    const item = new api.TreeItem(label, api.TreeItemCollapsibleState.None)
    item.iconPath = new api.ThemeIcon('file-code')
    item.tooltip = node.entry.fullPath
    item.contextValue = 'diminaPage'
    // Clicking the node fires the open command with the page's full path.
    item.command = {
      command: DIMINA_OPEN_PAGE_COMMAND,
      title: 'Open Page Source',
      arguments: [node.entry.fullPath],
    }
    return item
  }

  async getChildren(node?: PagesNode): Promise<PagesNode[]> {
    const app = await readAppJson(this.api)
    if (!app) return []
    const pages = collectPages(app)

    if (!node) {
      // Root: main-package pages flat, then one group node per sub-package.
      const mainPages = pages.filter((p) => p.group === '')
      const groups = new Map<string, PageEntry[]>()
      for (const p of pages) {
        if (p.group === '') continue
        const arr = groups.get(p.group) ?? []
        arr.push(p)
        groups.set(p.group, arr)
      }
      const nodes: PagesNode[] = mainPages.map((entry) => ({ kind: 'page', entry }))
      for (const [group, groupPages] of groups) {
        nodes.push({ kind: 'group', group, label: group, pages: groupPages })
      }
      return nodes
    }

    if (node.kind === 'group') {
      return node.pages.map((entry) => ({ kind: 'page', entry }))
    }
    return []
  }
}

/** Human-readable page label: last two path segments (e.g. `view/view`) for compactness. */
function pageLabel(entry: PageEntry): string {
  const segs = entry.fullPath.split('/')
  return segs.length >= 2 ? segs.slice(-2).join('/') : entry.fullPath
}

class DiminaAppConfigProvider implements vscode.TreeDataProvider<AppConfigNode> {
  private readonly _onDidChange: vscode.EventEmitter<AppConfigNode | undefined | void>
  readonly onDidChangeTreeData: vscode.Event<AppConfigNode | undefined | void>

  constructor(private readonly api: typeof vscode) {
    this._onDidChange = new api.EventEmitter<AppConfigNode | undefined | void>()
    this.onDidChangeTreeData = this._onDidChange.event
  }

  refresh(): void {
    this._onDidChange.fire()
  }

  getTreeItem(node: AppConfigNode): vscode.TreeItem {
    const api = this.api
    if (node.kind === 'section') {
      const item = new api.TreeItem(node.label, api.TreeItemCollapsibleState.Expanded)
      item.iconPath = new api.ThemeIcon('settings-gear')
      return item
    }
    const item = new api.TreeItem(node.label, api.TreeItemCollapsibleState.None)
    if (node.description) item.description = node.description
    item.iconPath = new api.ThemeIcon('symbol-property')
    return item
  }

  async getChildren(node?: AppConfigNode): Promise<AppConfigNode[]> {
    if (node) {
      return node.kind === 'section' ? node.children : []
    }
    const app = await readAppJson(this.api)
    if (!app) return []
    return buildAppConfigSections(app)
  }
}

/** Build the read-only App Config overview from window + tabBar config. */
function buildAppConfigSections(app: AppJson): AppConfigNode[] {
  const sections: AppConfigNode[] = []

  if (app.window && Object.keys(app.window).length > 0) {
    sections.push({
      kind: 'section',
      label: 'Window',
      children: Object.entries(app.window).map(([key, value]) => ({
        kind: 'leaf',
        label: key,
        description: String(value),
      })),
    })
  }

  const tabList = app.tabBar?.list ?? []
  if (tabList.length > 0) {
    sections.push({
      kind: 'section',
      label: 'TabBar',
      children: tabList.map((tab) => ({
        kind: 'leaf',
        label: tab.text ?? tab.pagePath ?? '(tab)',
        description: tab.pagePath,
      })),
    })
  }

  return sections
}

/**
 * Attach the dimina sidebar TreeViews + the open-page command to the page-side
 * vscode API. The view ids must match `DIMINA_SIDEBAR_MANIFEST`'s contributed
 * views so they render inside the contributed Activity Bar container.
 */
export function registerDiminaSidebar(api: typeof vscode): vscode.Disposable {
  const disposables: vscode.Disposable[] = []

  const pagesProvider = new DiminaPagesProvider(api)
  disposables.push(
    api.window.createTreeView(DIMINA_PAGES_VIEW_ID, {
      treeDataProvider: pagesProvider,
      showCollapseAll: true,
    }),
  )

  const appConfigProvider = new DiminaAppConfigProvider(api)
  disposables.push(
    api.window.createTreeView(DIMINA_APP_CONFIG_VIEW_ID, {
      treeDataProvider: appConfigProvider,
    }),
  )

  // Open the first existing source file for a page path. A page may ship as
  // `.qml`/`.wxml`/`.js`; probe candidate extensions and open the first hit.
  disposables.push(
    api.commands.registerCommand(DIMINA_OPEN_PAGE_COMMAND, async (fullPath: string) => {
      if (typeof fullPath !== 'string') return
      const uri = await resolvePageSourceUri(api, fullPath)
      if (!uri) {
        void api.window.showWarningMessage(`No source file found for page: ${fullPath}`)
        return
      }
      await api.window.showTextDocument(uri, { preview: true })
    }),
  )

  // Re-read app.json on save so the trees track edits to the project layout.
  disposables.push(
    api.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.toString().endsWith('/app.json')) {
        pagesProvider.refresh()
        appConfigProvider.refresh()
      }
    }),
  )

  return api.Disposable.from(...disposables)
}
