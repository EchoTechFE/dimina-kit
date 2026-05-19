// Library entry for the H5 container — re-exports the two upstream classes
// the simulator embeds. Lives outside `dimina/` so the submodule can point at
// plain upstream `didi/dimina` with zero local modifications. Built by
// vite.config.api.js into dist/assets/container-api.js; main.tsx imports the
// resulting bundle as `container-api`.
//
// `@/...` resolves via the alias defined in vite.config.api.js, which mirrors
// upstream container's own vite.config.mjs (`@: containerRoot/src`).
export { Application } from '@/pages/application/application'
export { MiniApp } from '@/pages/miniApp/miniApp'
