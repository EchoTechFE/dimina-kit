/**
 * Built-in template policy merge logic.
 *
 * `resolveTemplates(builtin, injected, mode)`:
 *  - mode='all'     → keep every built-in
 *  - mode='none'    → drop every built-in
 *  - mode=string[]  → keep only built-ins whose id is in the whitelist
 *
 * Injected templates always win over a same-id built-in. Order is:
 * injected (input order) ++ remaining built-ins (in their input order
 * for 'all'; in the whitelist's order for an array mode).
 */
import type { BuiltinTemplatesMode, ProjectTemplate } from './types.js'

export function resolveTemplates(
  builtin: ProjectTemplate[],
  injected: ProjectTemplate[],
  mode: BuiltinTemplatesMode,
): ProjectTemplate[] {
  let kept: ProjectTemplate[]
  if (mode === 'none') {
    kept = []
  } else if (mode === 'all') {
    kept = [...builtin]
  } else {
    // Whitelist: keep only listed ids, in the whitelist's order. Unknown
    // ids are dropped silently — the user opted in to a curated subset and
    // we don't want a typo to crash the new-project dialog.
    const byId = new Map(builtin.map((t) => [t.id, t]))
    kept = []
    for (const id of mode) {
      const t = byId.get(id)
      if (t) kept.push(t)
    }
  }

  // Strip any built-ins whose id is overridden by an injected template, then
  // prepend the injected list so host-supplied versions win on rendering.
  const injectedIds = new Set(injected.map((t) => t.id))
  const remaining = kept.filter((t) => !injectedIds.has(t.id))
  return [...injected, ...remaining]
}

/**
 * Strip non-serialisable fields (e.g. `generate` functions) so the merged
 * catalog can be sent across the renderer IPC boundary. Anything left is
 * structured-clonable.
 */
export function sanitizeTemplates(
  templates: ProjectTemplate[],
): ProjectTemplate[] {
  return templates.map((t) => {
    // `generate` is a function and would throw on structuredClone / IPC.
    const { generate: _generate, ...rest } = t
    return rest
  })
}
