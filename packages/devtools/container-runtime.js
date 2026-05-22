// Library entry for the H5 container — re-exports the two upstream classes
// the simulator embeds. Lives outside `dimina/` so the submodule can point at
// plain upstream `didi/dimina` with zero local modifications. Built by
// vite.config.api.js into dist/assets/container-api.js; main.tsx imports the
// resulting bundle as `container-api`.
//
// `@/...` resolves via the alias defined in vite.config.api.js, which mirrors
// upstream container's own vite.config.mjs (`@: containerRoot/src`).

// Global stylesheet — `body` font-family/size reset plus `* { margin/padding }`.
// Upstream's index.html pulls this in via index.js; the library build did not,
// so the simulator document fell back to the UA serif font for the navigation
// bar title (a bare <h2> with no font-family of its own). Importing it here
// folds the reset into container.css, which the simulator loads.
import '@/styles/app.scss'

export { Application } from '@/pages/application/application'
export { MiniApp } from '@/pages/miniApp/miniApp'
