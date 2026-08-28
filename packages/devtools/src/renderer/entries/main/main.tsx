import ReactDOM from 'react-dom/client'
import '../../design.css'
import Main from '../../modules/main/main'
import { ensurePlacementGenerationSeeded } from '../../shared/renderer-placement-generation'

/** Surface a fatal boot failure without mounting React — see the `.catch()` below. */
function renderFatalStartupError(err: unknown): void {
  console.error('[devtools] fatal: could not allocate a placement-generation seed before first render', err)
  const root = document.getElementById('root')
  if (root) root.textContent = 'Dimina DevTools failed to start. Please restart the app.'
}

// Resolve the placement-generation seed from main BEFORE the first render —
// every screen's `useState(() => nextPlacementGeneration())` initializer
// must run synchronously against an already-seeded counter (see
// renderer-placement-generation.ts for why the seed can't come from
// Date.now()). A rejection here must NOT fall through to mounting the app —
// `ensurePlacementGenerationSeeded()` only rejects after exhausting its
// retries, at which point there is no safe local-only counter to render
// against (see that module's doc-comment).
ensurePlacementGenerationSeeded()
  .then(() => {
    ReactDOM.createRoot(document.getElementById('root')!).render(<Main />)
  })
  .catch(renderFatalStartupError)
