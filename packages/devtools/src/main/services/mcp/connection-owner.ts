/**
 * Which project window a CDP target belongs to.
 *
 * MCP keeps one `simulator` and one `workbench` connection for the whole app,
 * so every connection has to record the window it ACTUALLY reached: one
 * recorded as arrived is left alone, one recorded elsewhere keeps retrying
 * until it lands on the window the user is in.
 */

/** The per-window facts that decide which window a target belongs to. */
export interface TargetIdentityFacts {
  activeBridgeId: string | null
  getProjectPath: () => string
  getAppId: () => string | null
}

export interface TargetBinding {
  owner: object | null
  onTarget: boolean
}

/** The value of query `key` in a target URL, or null when it carries none. */
export function targetQuery(url: string | undefined, key: string): string | null {
  if (!url) return null
  try {
    return new URL(url).searchParams.get(key)
  } catch {
    return null
  }
}

function bind(owner: object, intended: object | null): TargetBinding {
  return { owner, onTarget: owner === intended }
}

/** The window whose workbench renderer has this target's project open. */
function workbenchOwner(
  url: string | undefined,
  windows: ReadonlyMap<object, TargetIdentityFacts>,
): object | null {
  const path = targetQuery(url, 'path')
  if (!path) return null
  for (const [candidate, facts] of windows) {
    if (facts.getProjectPath() === path) return candidate
  }
  return null
}

/**
 * The window this simulator surface belongs to: a render guest names it through
 * its `bridgeId`, the localhost:7788 shell through the `appId` its route
 * carries. Two windows answering to one appId — what two projects declaring the
 * same appId produce — name no single window, so neither is returned.
 */
function simulatorOwner(
  url: string | undefined,
  windows: ReadonlyMap<object, TargetIdentityFacts>,
): object | null {
  const bridgeId = targetQuery(url, 'bridgeId')
  if (bridgeId !== null) {
    for (const [candidate, facts] of windows) {
      if (facts.activeBridgeId === bridgeId) return candidate
    }
    return null
  }

  const appId = targetQuery(url, 'appId')
  if (appId === null) return null
  let shell: object | null = null
  for (const [candidate, facts] of windows) {
    if (facts.getAppId() !== appId) continue
    if (shell) return null
    shell = candidate
  }
  return shell
}

/**
 * The window a chosen target belongs to, and whether that is the window MCP
 * means to drive right now.
 *
 * A simulator target that names no window it can be attributed to is treated as
 * the wrong window on purpose: it may well be another project's, and keeping the
 * retries running is what moves the connection onto the active window's render
 * guest as soon as that guest exists. The one target that legitimately names no
 * window is the project list, which is the right workbench surface exactly
 * while no project window is open.
 */
export function connectionOwner(
  kind: 'simulator' | 'workbench',
  url: string | undefined,
  intended: object | null,
  windows: ReadonlyMap<object, TargetIdentityFacts>,
): TargetBinding {
  const owner = kind === 'workbench' ? workbenchOwner(url, windows) : simulatorOwner(url, windows)
  if (owner) return bind(owner, intended)
  return { owner: null, onTarget: kind === 'workbench' && intended === null }
}
