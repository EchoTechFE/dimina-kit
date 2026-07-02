// Replacement for oxc-walker's `walk` (generic ESTree-ish traversal).
// The compiler only uses walk(ast, { enter(node, parent) }) — no skip/replace/remove.
const SKIP_KEYS = new Set([
  'type', 'start', 'end', 'loc', 'range', 'parent',
  'leadingComments', 'trailingComments', 'innerComments',
])

export function walk(ast, visitor = {}) {
  const { enter, leave } = visitor
  function visit(node, parent) {
    if (!node || typeof node.type !== 'string') return
    if (enter) enter(node, parent)
    for (const key in node) {
      if (SKIP_KEYS.has(key)) continue
      const val = node[key]
      if (Array.isArray(val)) {
        for (const c of val) {
          if (c && typeof c.type === 'string') visit(c, node)
        }
      } else if (val && typeof val.type === 'string') {
        visit(val, node)
      }
    }
    if (leave) leave(node, parent)
  }
  visit(ast, null)
}

export default { walk }
