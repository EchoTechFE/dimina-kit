/**
 * Single source of truth for the compile-mode model: the named modes a
 * project defines, which one is selected, and how that selection resolves
 * into the launch parameters a compile runs with.
 *
 * The stored form (`CompileModes`) is WeChat DevTools' `condition.miniprogram`
 * shape, so `project.config.json` round-trips between both tools. Everything
 * here is pure — the storage side lives in main's `project-repository.ts`,
 * the UI side in the compile-mode popover.
 */

import { DEFAULT_SCENE } from './constants.js'
import type { CompileConfig, CompileMode, CompileModes } from './types.js'

/**
 * `CompileModes.current` value selecting 普通编译 — launch the app's own
 * entry page with the default scene and no params. It is not an entry in
 * `list`: 普通编译 is fixed and has nothing to edit, matching WeChat, where
 * the same fixed item sits above the custom list at index -1.
 */
export const NORMAL_COMPILE_INDEX = -1

/** Label shown when no custom mode is selected. */
const NORMAL_COMPILE_LABEL = '普通编译'

/**
 * Stand-in for a custom mode the user never named. It must not read as
 * 普通编译: a mode can legitimately have an empty name AND an empty
 * `pathName` (its 启动页面 left on 默认为首页) while still carrying params or
 * a scene, and calling that 普通编译 would tell the user they are running
 * something they are not.
 */
export const UNNAMED_MODE_LABEL = '未命名模式'

/**
 * Parse a raw `k=v&k2=v2` query string into ordered pairs.
 *
 * Unlike `decodePageSpec` (which yields a `Record` and so silently collapses
 * repeats), this preserves order and duplicate keys — the k/v editor shows
 * exactly what the user typed into the raw field, including `a=1&a=2`.
 * A bare segment with no `=` parses to an empty value.
 */
export function parseQueryString(query: string): { key: string; value: string }[] {
  const pairs: { key: string; value: string }[] = []
  for (const segment of query.split('&')) {
    if (!segment) continue
    const eqIdx = segment.indexOf('=')
    const rawKey = eqIdx >= 0 ? segment.slice(0, eqIdx) : segment
    const rawValue = eqIdx >= 0 ? segment.slice(eqIdx + 1) : ''
    if (!rawKey) continue
    pairs.push({ key: safeDecode(rawKey), value: safeDecode(rawValue) })
  }
  return pairs
}

/**
 * Serialize ordered pairs back into a raw query string. Rows with an empty
 * key are dropped — the k/v editor keeps a blank row around while the user
 * is still typing, and a blank row is not a parameter.
 */
export function stringifyQueryParams(
  params: { key: string; value: string }[],
): string {
  return params
    .filter((p) => p.key)
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join('&')
}

/**
 * Resolve the selected mode into the launch parameters. 普通编译 (and any
 * out-of-range `current`, which a hand-edited config file can produce)
 * resolves to an empty `startPage`; the caller substitutes the project's own
 * entry page for it, since only the caller knows the project.
 */
export function resolveCompileConfig(modes: CompileModes): CompileConfig {
  const mode = selectedMode(modes)
  if (!mode) {
    return { startPage: '', scene: DEFAULT_SCENE, queryParams: [] }
  }
  return {
    startPage: mode.pathName,
    scene: mode.scene ?? DEFAULT_SCENE,
    queryParams: parseQueryString(mode.query),
  }
}

/**
 * Text for the toolbar's compile-mode button: the selected mode's name,
 * falling back to its start page when the user left the name blank, so an
 * unnamed mode is still identifiable. Only 普通编译 itself may produce the
 * 普通编译 label — see {@link UNNAMED_MODE_LABEL}.
 */
export function compileModeLabel(modes: CompileModes): string {
  const mode = selectedMode(modes)
  if (!mode) return NORMAL_COMPILE_LABEL
  return mode.name || mode.pathName || UNNAMED_MODE_LABEL
}

/**
 * Coerce whatever is on disk into a usable `CompileModes`. The source is a
 * user-editable JSON file that another tool also writes, so every field is
 * treated as untrusted: a malformed file degrades to 普通编译 rather than
 * failing the project open.
 */
export function normalizeCompileModes(raw: unknown): CompileModes {
  if (!isRecord(raw)) return emptyCompileModes()
  const list: CompileMode[] = []
  if (Array.isArray(raw.list)) {
    for (const item of raw.list) {
      const mode = normalizeCompileMode(item)
      if (mode) list.push(mode)
    }
  }
  const current = Number.isInteger(raw.current) ? (raw.current as number) : NORMAL_COMPILE_INDEX
  return {
    current: current >= 0 && current < list.length ? current : NORMAL_COMPILE_INDEX,
    list,
  }
}

/** An empty model — no custom modes, 普通编译 selected. */
export function emptyCompileModes(): CompileModes {
  return { current: NORMAL_COMPILE_INDEX, list: [] }
}

/**
 * Build a mode out of resolved launch parameters. Used to migrate a legacy
 * single compile config into the list, and by the popover when the user
 * turns the simulator's current page into a mode.
 */
export function compileConfigToMode(config: CompileConfig, name: string): CompileMode {
  return {
    name,
    pathName: config.startPage,
    query: stringifyQueryParams(config.queryParams ?? []),
    scene: config.scene,
  }
}

/**
 * Whether resolved launch parameters are exactly what 普通编译 already
 * launches, and so carry nothing worth surfacing as a named mode. An empty
 * `startPage` means "the app's own entry page", which is what 普通编译 is;
 * `entryPagePath` lets a caller that knows the project also recognize a config
 * that names that page outright.
 */
export function isNormalCompile(config: CompileConfig, entryPagePath: string): boolean {
  return (!config.startPage || config.startPage === entryPagePath)
    && (config.scene ?? DEFAULT_SCENE) === DEFAULT_SCENE
    && (config.queryParams?.length ?? 0) === 0
}

/**
 * Project a single legacy compile config into the mode list, as one unnamed
 * selected mode — unless it asks for nothing 普通编译 can't already do, in
 * which case the list stays empty rather than gaining a mode that says the
 * same thing as the fixed entry above it.
 *
 * Both places that meet the older single-config form go through here: the
 * project repository migrating `dimina-projects.json`, and the workspace
 * adapter reading a host that only implements `getCompileConfig`. Callers that
 * can resolve the project's entry page pass it so a config naming that page
 * counts as 普通编译 too.
 */
export function compileConfigToModes(
  config: CompileConfig,
  entryPagePath = '',
): CompileModes {
  if (isNormalCompile(config, entryPagePath)) return emptyCompileModes()
  return { current: 0, list: [compileConfigToMode(config, '')] }
}

/**
 * Build a mode from a `pagePath?k=v&…` route string — the format
 * `getCurrentPageRoute` reports for the simulator's visible page, which is
 * what "以当前页面新建编译模式" starts from. Scene is left unset so the new
 * mode launches with the default rather than inheriting whatever scene the
 * running session happened to use.
 */
export function routeToMode(route: string, name: string): CompileMode {
  const qIdx = route.indexOf('?')
  return {
    name,
    pathName: qIdx >= 0 ? route.slice(0, qIdx) : route,
    query: qIdx >= 0 ? route.slice(qIdx + 1) : '',
    scene: null,
  }
}

/**
 * Select a mode by index, or 普通编译 with {@link NORMAL_COMPILE_INDEX}. An
 * index that isn't in the list falls back to 普通编译 rather than leaving
 * `current` pointing at nothing.
 */
export function selectCompileMode(modes: CompileModes, index: number): CompileModes {
  return {
    current: isSelectable(modes.list, index) ? index : NORMAL_COMPILE_INDEX,
    list: [...modes.list],
  }
}

/**
 * Insert (`index === null`) or replace a mode. A new mode is appended AND
 * selected — the user created it to run it. `relaunch` reports whether the
 * running configuration changed, so editing some other mode doesn't restart
 * the simulator.
 */
export function upsertCompileMode(
  modes: CompileModes,
  index: number | null,
  mode: CompileMode,
): { modes: CompileModes; relaunch: boolean } {
  const list = [...modes.list]
  if (index === null || !isSelectable(list, index)) {
    list.push(mode)
    return { modes: { current: list.length - 1, list }, relaunch: true }
  }
  list[index] = mode
  return {
    modes: { current: modes.current, list },
    relaunch: index === modes.current,
  }
}

/**
 * Delete a mode, keeping `current` on whatever was selected before: removing
 * an earlier entry shifts it down, removing the selected one falls back to
 * 普通编译 (the only selection that is always valid).
 */
export function removeCompileMode(
  modes: CompileModes,
  index: number,
): { modes: CompileModes; relaunch: boolean } {
  if (!isSelectable(modes.list, index)) {
    return { modes: { current: modes.current, list: [...modes.list] }, relaunch: false }
  }
  const list = modes.list.filter((_, i) => i !== index)
  if (modes.current === index) {
    return { modes: { current: NORMAL_COMPILE_INDEX, list }, relaunch: true }
  }
  return {
    modes: { current: modes.current > index ? modes.current - 1 : modes.current, list },
    relaunch: false,
  }
}

function isSelectable(list: CompileMode[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < list.length
}

function selectedMode(modes: CompileModes): CompileMode | null {
  const list = modes?.list
  if (!Array.isArray(list)) return null
  const current = modes.current
  if (!Number.isInteger(current) || current < 0 || current >= list.length) return null
  return list[current] ?? null
}

/**
 * A mode needs a start page to mean anything, so an entry without a string
 * `pathName` is dropped rather than kept as an unlaunchable row. Unknown
 * fields WeChat writes are carried through untouched.
 */
function normalizeCompileMode(raw: unknown): CompileMode | null {
  if (!isRecord(raw)) return null
  if (typeof raw.pathName !== 'string') return null
  const scene = typeof raw.scene === 'number'
    ? raw.scene
    : typeof raw.scene === 'string' && raw.scene.trim() !== '' && Number.isFinite(Number(raw.scene))
      ? Number(raw.scene)
      : null
  const mode: CompileMode = {
    name: typeof raw.name === 'string' ? raw.name : '',
    pathName: raw.pathName,
    query: typeof raw.query === 'string' ? raw.query : '',
    scene,
  }
  if ('launchMode' in raw) mode.launchMode = raw.launchMode
  if ('partialCompile' in raw) mode.partialCompile = raw.partialCompile
  return mode
}

/**
 * `decodeURIComponent` throws on a lone `%` — which a user editing the raw
 * query field types on the way to `%20`. Keep the literal text instead of
 * losing the whole field to an exception.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
