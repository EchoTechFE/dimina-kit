import ReactDOM from 'react-dom/client'
import '../../design.css'
import Main from '../../modules/main/main'
import { ensurePlacementGenerationSeeded } from '../../shared/renderer-placement-generation'

// Resolve the placement-generation seed from main BEFORE the first render —
// every screen's `useState(() => nextPlacementGeneration())` initializer
// must run synchronously against an already-seeded counter (see
// renderer-placement-generation.ts for why the seed can't come from
// Date.now()).
void ensurePlacementGenerationSeeded().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(<Main />)
})
