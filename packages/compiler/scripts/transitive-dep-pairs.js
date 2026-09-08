// Resolution PATHS for dependencies dmcc's own `autoprefixer` call pulls in
// transitively that neither kit nor dmcc declares directly — but whose
// resolved version DOES affect compiled output:
// `overrideBrowserslist: ['cover 99.5%']` is a usage-share query, and
// caniuse-lite ships new usage data every few days, so a patch-level drift
// alone can flip whether a property gets an extra vendor prefix. Because
// neither side declares these, the direct-dep loops in
// check-wasm-alignment.js/snapshot-upstream-versions.js never see them —
// they only ever surface as an unexplained CSS byte diff.
//
// Each entry is the full chain of package names to walk from the anchor,
// not just an immediate [parent, child] pair: `caniuse-lite` is required
// TWICE, independently, on two different edges — once directly by
// `autoprefixer` (feature-support lookups) and once by `browserslist`
// (usage-share stats, itself reached only via `autoprefixer`'s own
// `browserslist` dependency). pnpm resolves each edge on its own; pinning
// only the direct `autoprefixer>caniuse-lite` edge leaves
// `autoprefixer>browserslist>caniuse-lite` free to drift to whatever's
// newest in the store. Both edges are tracked here so both scripts resolve
// each `name` through the exact chain that requires it, not through kit's/
// dmcc's package root — pnpm's isolated node_modules means those
// resolutions can land in different physical installs.
export const TRANSITIVE_DEP_PATHS = [
  ['autoprefixer', 'browserslist'],
  ['autoprefixer', 'caniuse-lite'],
  ['autoprefixer', 'browserslist', 'caniuse-lite'],
]
