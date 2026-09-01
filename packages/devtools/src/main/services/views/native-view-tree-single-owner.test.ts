/**
 * Source-scan guard for the invariant documented at the top of
 * native-view-tree.ts: `createNativeViewTreeHost` is the SINGLE owner of the
 * main window's native child tree. Nothing in the type system stops a new
 * module from calling `mainWindow.contentView.addChildView(...)` directly —
 * the only thing that would catch it is a human noticing in review. This
 * pins that as an automated, greppable check.
 *
 * Mechanism: a plain recursive-readdir + regex scan (no ESLint AST rule, no
 * new dependency) over the package's own production sources, mirroring the
 * inventory-scan style already used by the grandfather-ceiling block in
 * eslint-workbench-context-gate.test.ts (fs.readdirSync + fs.readFileSync +
 * regex, no temp files). An AST rule was not chosen: the property the rule
 * cares about (`contentView`) is a plain identifier, no type information is
 * needed to key on it, and no eslint.config.js changes are allowed here
 * (production config is off-limits for this change).
 *
 * Pattern precision: matching bare `.addChildView(` / `.removeChildView(`
 * (any receiver) would also flag `contentViewHost.addChildView(...)` in
 * placement-reconciler.ts — that call goes through the NativeViewTreeHost
 * returned by createNativeViewTreeHost, i.e. through the owner, not around
 * it. Keying on the literal `contentView.addChildView(` /
 * `contentView.removeChildView(` qualifier (word-boundary before
 * `contentView`) matches Electron's real property access without matching
 * `contentViewHost` (no boundary between `contentView` and the trailing
 * `Host`), so the wrapper call is correctly left alone.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
)
const srcRoot = path.join(packageRoot, 'src')

/** Owner file: the only place the mutating calls may live. */
const OWNER_FILE = 'main/services/views/native-view-tree.ts'

/**
 * File-path-level exemptions. Each entry is a one-time construction-site
 * wrap, not an ongoing mutation of the reconciled tree, and each carries its
 * own justification:
 *
 *  - main-window/create.ts: runs once, before native-view-tree.ts (and its
 *    reconciler) exist at all. It wraps the window's default WebContentsView
 *    into a fresh `View` container so later `addChildView` calls have a
 *    container to land in — bootstrapping the owner's substrate, not a
 *    second owner of it.
 *  - internal-devtools-window/index.ts: the same wrap-in-a-View pattern, but
 *    applied to a DIFFERENT window (the standalone "全局调试" window). It
 *    never touches `mainWindow`, so it cannot violate a main-window-scoped
 *    invariant.
 */
const WHITELIST: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'main/windows/main-window/create.ts',
    reason:
      'one-time construction wrap of the default WebContentsView, before the reconciler/owner exists',
  },
  {
    file: 'main/windows/internal-devtools-window/index.ts',
    reason:
      'wraps a DIFFERENT window (the standalone debug window), never mainWindow',
  },
]
const WHITELIST_FILES = new Set(WHITELIST.map((w) => w.file))

/** Matches `contentView.addChildView(` / `contentView.removeChildView(`, keyed on the `contentView` qualifier so `contentViewHost.addChildView(` (the owner's own wrapper API) is left alone. */
const CONTENT_VIEW_MUTATION_RE = /\bcontentView\s*\.\s*(addChildView|removeChildView)\s*\(/
/** The legacy BrowserView attach/detach API — same single-owner concern, distinct method names. */
const BROWSER_VIEW_MUTATION_RE = /\.\s*(addBrowserView|setBrowserView)\s*\(/

interface Hit {
  relFile: string
  line: number
  text: string
}

function listProductionFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listProductionFiles(full))
    } else if (entry.isFile() && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/**
 * Scans one file's text and returns every mutating-call hit, by line.
 *
 * Scans the whole text rather than each line on its own: a formatter may put
 * the receiver and the call on separate lines (`…contentView` then
 * `.addChildView(view)`), and a per-line scan would never see either half as a
 * match. The patterns allow whitespace — newlines included — around the dot and
 * the opening paren for the same reason.
 */
function scanFileText(relFile: string, text: string): Hit[] {
  const lines = text.split('\n')
  const hits: Hit[] = []
  for (const re of [CONTENT_VIEW_MUTATION_RE, BROWSER_VIEW_MUTATION_RE]) {
    for (const match of text.matchAll(new RegExp(re.source, 'g'))) {
      // 1-based line of the match start; the reported text is that whole line.
      const line = text.slice(0, match.index).split('\n').length
      hits.push({ relFile, line, text: lines[line - 1]!.trim() })
    }
  }
  return hits.sort((a, b) => a.line - b.line)
}

/** Scans the real repository tree under `src/`. */
function scanRepo(): Hit[] {
  const hits: Hit[] = []
  for (const file of listProductionFiles(srcRoot)) {
    const relFile = path.relative(srcRoot, file).split(path.sep).join('/')
    hits.push(...scanFileText(relFile, fs.readFileSync(file, 'utf8')))
  }
  return hits
}

function formatViolation(h: Hit): string {
  return `packages/devtools/src/${h.relFile}:${h.line}: ${h.text}`
}

describe('main window native child-tree: single-owner scan', () => {
  it('calls through the owner wrapper (contentViewHost.addChildView) are not flagged', () => {
    // This is the exact shape placement-reconciler.ts uses to call through
    // the owner's own NativeViewTreeHost API — it must never be mistaken for
    // a direct Electron call.
    expect(CONTENT_VIEW_MUTATION_RE.test('contentViewHost.addChildView({ id: viewId })')).toBe(false)
    expect(CONTENT_VIEW_MUTATION_RE.test('contentViewHost.removeChildView({ id: viewId })')).toBe(false)
  })

  it('direct Electron calls on mainWindow.contentView are flagged', () => {
    expect(
      CONTENT_VIEW_MUTATION_RE.test('ctx.windows.mainWindow.contentView.addChildView(view)'),
    ).toBe(true)
    expect(
      CONTENT_VIEW_MUTATION_RE.test('ctx.windows.mainWindow.contentView.removeChildView(view)'),
    ).toBe(true)
  })

  it('regex matches the legacy BrowserView API on any receiver', () => {
    expect(BROWSER_VIEW_MUTATION_RE.test('mainWindow.addBrowserView(view)')).toBe(true)
    expect(BROWSER_VIEW_MUTATION_RE.test('mainWindow.setBrowserView(view)')).toBe(true)
  })

  it('a mutation broken across lines by a formatter is still flagged', () => {
    // Prettier-style wrapping puts the receiver and the call on separate
    // lines. A scan that restarts at every newline sees neither half and lets
    // a real new owner through.
    const wrapped = 'const v = ctx.windows.mainWindow.contentView\n  .addChildView(view)\n'
    const hits = scanFileText('probe.ts', wrapped)
    expect(hits.length).toBe(1)
    expect(hits[0]!.line).toBe(1)

    const wrappedBrowserView = 'mainWindow\n  .addBrowserView(view)\n'
    expect(scanFileText('probe.ts', wrappedBrowserView).length).toBe(1)
  })

  it('the construction-site exemption is keyed on file path, so it survives an equivalent direct-call refactor', () => {
    // create.ts and internal-devtools-window/index.ts do NOT currently write
    // the `contentView.addChildView(` shape (they wrap a plain `container`
    // instead) — so today they never trip the pattern at all. The file-path
    // exemption exists for the equivalent refactor: if either site were
    // rewritten to call `mainWindow.contentView.addChildView(...)` /
    // `hostWindow.contentView.addChildView(...)` directly, it would still be
    // the SAME one-time bootstrap, not a new owner, and must stay exempt.
    for (const { file } of WHITELIST) {
      const hits = scanFileText(file, 'container.contentView.addChildView(mainWebView)\n')
      expect(hits.length, `${file} should match the pattern in this synthetic probe`).toBe(1)
      expect(
        WHITELIST_FILES.has(file),
        `${file} must be in the whitelist so an equivalent direct-call refactor stays exempt`,
      ).toBe(true)
    }
  })

  it('every mutating call under packages/devtools/src lives in the owner file or a whitelisted construction site', () => {
    const hits = scanRepo()
    const violations = hits.filter(
      (h) => h.relFile !== OWNER_FILE && !WHITELIST_FILES.has(h.relFile),
    )

    expect(
      violations,
      violations.length === 0
        ? ''
        : 'a new native child-tree mutation site was introduced outside the ' +
            `single owner (${OWNER_FILE}). Route it through ` +
            'createNativeViewTreeHost instead, or — if this really is a new ' +
            'legitimate one-time construction wrap — add it to WHITELIST ' +
            'with a justification.\n' +
            violations.map(formatViolation).join('\n'),
    ).toEqual([])
  })

  it('the owner file still shows its own calls, so an empty result cannot mean the scan lost the tree', () => {
    const ownerHits = scanRepo().filter((h) => h.relFile === OWNER_FILE)
    expect(
      ownerHits.length,
      'native-view-tree.ts should still show its own addChildView/removeChildView calls — a change here would mean the scan stopped seeing real files',
    ).toBeGreaterThanOrEqual(3)
  })
})
