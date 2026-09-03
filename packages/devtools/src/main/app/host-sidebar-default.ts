import path from 'path'
import type { ViewManager } from '../services/views/view-manager.js'
import type { RendererNotifier } from '../services/notifications/renderer-notifier.js'
import type { DisposableRegistry } from '@dimina-kit/electron-deck/main'
import { HOST_SIDEBAR_DEFAULT_WIDTH } from '../../shared/constants.js'

/** Narrow view of the context fields the default sidebar content depends on. */
export interface HostSidebarContext {
  views: ViewManager
  notify: RendererNotifier
  registry: DisposableRegistry
}

/**
 * devtools' own default content for the host-sidebar slot: a narrow icon rail
 * (logo + 小程序/小游戏 toggle) filtering the project-list grid by
 * `Project.type`. Loaded BEFORE `config.onSetup` runs, so any downstream
 * `loadURL`/`loadFile` call inside onSetup necessarily happens later and
 * naturally supersedes this default via plain chronological ordering — no
 * override flag needed.
 */
export function installHostSidebarDefault(context: HostSidebarContext, rendererDir: string): void {
  context.registry.add(
    context.views.hostSidebar.onMessage('project-category-selected', (payload) => {
      const category = (payload as { category?: unknown } | null)?.category
      if (category !== 'miniprogram' && category !== 'minigame') return
      context.notify.hostSidebarCategorySelected(category)
    }),
  )
  context.views.hostSidebar
    .loadFile(path.join(rendererDir, 'entries/host-sidebar-default/index.html'))
    .catch((err) => {
      console.warn('[workbench] failed to load host-sidebar default content:', err)
    })
  // Seed the notified width with the rail's own known intrinsic width
  // (`HOST_SIDEBAR_DEFAULT_WIDTH`) instead of leaving it at 0 until the
  // rail's in-page advertiser reports back. That report can never arrive on
  // its own: the placeholder above only becomes "desired visible" once a
  // nonzero width is known (project-list-screen.tsx), attach only happens
  // for a "desired visible" view (placement-reconciler.ts), and the rail's
  // advertiser (view-anchor's measure-loop.ts) only ever fires via
  // `requestAnimationFrame`, which Chromium never schedules for a
  // WebContentsView that was never attached — a structural deadlock, not a
  // slow-to-resolve race. `setWidthMode({fixed})` pushes the seed
  // synchronously (no attach/rAF dependency) and, critically, retains it in
  // `getHostSidebarWidth()` too, so a renderer that mounts and pulls before
  // any push replays the real seed instead of a stale 0. Flipping back to
  // 'auto' immediately after, before anything has attached or advertised, is
  // a same-tick no-op past the seed (`setExtentMode`'s reapply branch only
  // fires once something has actually been advertised) — it leaves the slot
  // in 'auto' for whichever content ends up loaded (this rail's own later
  // report, or a downstream replacement's), not pinned.
  context.views.hostSidebar.setWidthMode({ fixed: HOST_SIDEBAR_DEFAULT_WIDTH })
  context.views.hostSidebar.setWidthMode('auto')
}
