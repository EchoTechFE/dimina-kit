import type { ProjectSession } from '../../../shared/types.js'
import type { BridgeRouterHandle } from '../../ipc/bridge-router.js'
import type { ViewManager } from '../views/view-manager.js'
import type { ProjectsProvider } from '../projects/types.js'
import type { WorkspaceService } from './workspace-service.js'

/**
 * `captureThumbnail`/`getThumbnail` split out of WorkspaceService purely to keep
 * workspace-service.ts under the repo's file-length gate — the semantics (session/
 * project-path ownership, provider round-trip) still belong entirely to that service.
 * Takes a narrow slice of WorkbenchContext (views + bridge) rather than the whole
 * grab-bag type, so this split doesn't grow the WorkbenchContext-import ratchet.
 */
export function createThumbnailOps(input: {
  ctx: {
    views: Pick<ViewManager, 'getSimulatorWebContents' | 'getSimulatorProjectPath'>
    bridge?: BridgeRouterHandle
  }
  provider: ProjectsProvider
  getSession(): ProjectSession | null
  getProjectPath(): string
}): Pick<WorkspaceService, 'captureThumbnail' | 'getThumbnail'> {
  const { ctx, provider, getSession, getProjectPath } = input

  return {
    async captureThumbnail(projectPath) {
      if (!getSession() || projectPath !== getProjectPath()) return null
      const simulatorWc = ctx.views.getSimulatorWebContents()
      if (!simulatorWc) return null
      if (ctx.views.getSimulatorProjectPath() !== projectPath) return null
      const session = getSession()
      // Capture the active render-host guest (the mini-program content); the
      // simulator WCV only holds the device-shell chrome. In native-host with no
      // active guest (not mounted / mid page-switch / destroyed) return null
      // rather than persist a device-shell frame as the page — that wrong-content
      // frame is the bug this path exists to avoid. Non-native-host: the sim WCV.
      const bridge = ctx.bridge
      const nativeHost = bridge?.isNativeHost() ?? false
      const renderGuest = nativeHost ? (bridge?.getActiveRenderWc() ?? null) : null
      if (nativeHost && !renderGuest) return null
      const captureTarget = renderGuest ?? simulatorWc
      // A destroyed target means teardown is in flight (no valid frame) — return
      // null rather than let capturePage() throw indistinguishably into the catch.
      if (captureTarget.isDestroyed()) return null
      try {
        const image = await captureTarget.capturePage()
        if (
          getSession() !== session
          || getProjectPath() !== projectPath
          || ctx.views.getSimulatorWebContents() !== simulatorWc
          || ctx.views.getSimulatorProjectPath() !== projectPath
          // Captured target must still be the live one: a guest that navigated
          // mid-capture would otherwise persist a frame from the wrong page.
          || (nativeHost ? (bridge?.getActiveRenderWc() ?? null) : simulatorWc) !== captureTarget
        ) {
          return null
        }
        const dataUrl = `data:image/png;base64,${image.toPNG().toString('base64')}`
        if (provider.saveThumbnail) {
          await provider.saveThumbnail(projectPath, dataUrl)
        }
        // Always hand the renderer back the freshly-captured frame so the
        // UI updates immediately even if the host's saveThumbnail is
        // async or stores out-of-band.
        return dataUrl
      } catch {
        return null
      }
    },

    async getThumbnail(projectPath) {
      if (provider.getThumbnail) {
        return (await provider.getThumbnail(projectPath)) ?? null
      }
      return null
    },
  }
}
