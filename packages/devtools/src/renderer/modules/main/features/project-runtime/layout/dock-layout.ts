/**
 * Devtools "dockable mode" — layout-engine glue.
 *
 * Builds a `@dimina-kit/electron-deck` layout model for the devtools business
 * panels from the persisted, opaque serialized tree. The engine
 * (createLayoutModel / parse / validate / serialize) and `<DockView>` do the
 * real nesting + resize work; this module is only the registry + a default-tree
 * seed + a fallback-safe restore.
 *
 * The coarse `debug` panel is split into FIVE independent dock panels —
 * wxml / appdata / storage / console / compile — so each is its own dockable
 * unit. `console` is the only NATIVE panel (a main-process WebContentsView
 * routed through DockView's NativeSlot). `simulator` is a DOM panel:
 * `renderDomPanel('simulator')` renders `SimulatorPanel`, which draws the
 * device/zoom chrome AND owns the simulator WebContentsView anchor itself (a
 * bare native slot would render no chrome). editor + the four React-content
 * debug tabs (wxml/appdata/storage/compile) are DOM panels too. The simulator
 * leaf is locked to the device's pixel width via a `fixedPx` constraint so the
 * phone-region never stretches; its sibling stays weight-sized (an all-fixed
 * split is rejected by `validateTree`).
 */
import {
  createLayoutModel,
  createPanelRegistry,
  parseLayout,
  validateTree,
} from '@dimina-kit/electron-deck/layout'
import type {
  LayoutModel,
  LayoutTree,
  PanelRegistry,
} from '@dimina-kit/electron-deck/layout'

/**
 * Register the seven dock panels: DOM simulator + native console + DOM
 * editor + the four React-content debug tabs (wxml/appdata/storage/compile).
 *
 * `simulator` is a DOM panel: `renderDomPanel('simulator')` renders the
 * `SimulatorPanel` CHROME (device/zoom pickers, compile overlays, page-path
 * bar) and SimulatorPanel itself owns the main-process WebContentsView anchor
 * on its device-region div (via `createPlacementAnchor`). DockView's bare
 * `NativeSlot` would render no chrome, so the simulator cannot be native.
 *
 * `console` IS native: a main-process Chromium DevTools WebContentsView
 * overlaid onto a bare placeholder rect (no chrome). The four debug tabs are
 * DOM panels so `renderDomPanel` renders their React content.
 */
export function buildDockRegistry(): PanelRegistry {
  const registry = createPanelRegistry()
  registry.register({ kind: 'dom', id: 'simulator', title: 'Simulator' })
  registry.register({ kind: 'dom', id: 'editor', title: 'Editor' })
  registry.register({ kind: 'dom', id: 'wxml', title: 'WXML' })
  registry.register({ kind: 'dom', id: 'appdata', title: 'AppData' })
  registry.register({ kind: 'dom', id: 'storage', title: 'Storage' })
  registry.register({
    kind: 'native',
    id: 'console',
    title: 'Console',
    nativeRef: { id: 'console' },
  })
  registry.register({ kind: 'dom', id: 'compile', title: '编译' })
  return registry
}

/**
 * The default dock tree: a row split with the simulator pinned to
 * `simPanelWidth` px on the leading edge and a flexible column (editor over a
 * single tab strip holding the five debug panels) filling the rest. The five
 * debug panels (wxml/appdata/storage/console/compile) are co-located in ONE tab
 * group in pinned WeChat-DevTools order with WXML active, mirroring the legacy
 * BottomDebugPanel tab strip. Validates clean against the seven known ids.
 */
export function buildDefaultDockTree(simPanelWidth: number): LayoutTree {
  return {
    version: 1,
    root: {
      kind: 'split',
      id: 'root',
      orientation: 'row',
      // Defensive weights: the simulator child is fixed-px so its weight is
      // never used for sizing, but `sizes` must match `children.length`.
      sizes: [simPanelWidth, 1],
      constraints: [{ fixedPx: simPanelWidth }, null],
      children: [
        { kind: 'tabs', id: 'g-sim', panels: ['simulator'], active: 'simulator' },
        {
          kind: 'split',
          id: 'col-main',
          orientation: 'column',
          sizes: [70, 30],
          children: [
            { kind: 'tabs', id: 'g-editor', panels: ['editor'], active: 'editor' },
            {
              kind: 'tabs',
              id: 'g-debug',
              panels: ['wxml', 'appdata', 'storage', 'console', 'compile'],
              active: 'wxml',
            },
          ],
        },
      ],
    },
  }
}

/**
 * Build the observable model from the persisted (opaque) serialized tree.
 *
 * Fallback-safe: `null`, malformed JSON, a structurally-illegal tree, or a
 * structurally-valid-but-orphan tree (references a panel id outside
 * `knownPanelIds`) ALL fall back to the default tree at `simPanelWidth`. Only a
 * tree that round-trips through `parseLayout` AND passes `validateTree` clean
 * against `knownPanelIds` is restored verbatim.
 */
export function buildDockModel(
  serialized: string | null,
  simPanelWidth: number,
  knownPanelIds: ReadonlySet<string>,
): LayoutModel {
  const tree = restoreTreeOrDefault(serialized, simPanelWidth, knownPanelIds)
  return createLayoutModel(tree)
}

function restoreTreeOrDefault(
  serialized: string | null,
  simPanelWidth: number,
  knownPanelIds: ReadonlySet<string>,
): LayoutTree {
  if (serialized === null) return buildDefaultDockTree(simPanelWidth)
  try {
    const parsed = parseLayout(serialized)
    if (validateTree(parsed, knownPanelIds).length === 0) return parsed
  } catch {
    // malformed JSON / structurally-illegal tree — fall through to default.
  }
  return buildDefaultDockTree(simPanelWidth)
}
