import { useEffect, useRef } from 'react'
import {
  attachSimulatorUiRoot,
  dispatchSimulatorChromeAction,
} from '../ui-extension-runtime'

interface SimulatorUiExtensionLayerProps {
  active: boolean
  appId: string
}

export function SimulatorUiExtensionLayer({
  active,
  appId,
}: SimulatorUiExtensionLayerProps) {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!active || !root) return
    return attachSimulatorUiRoot(root, appId)
  }, [active, appId])

  return (
    <div
      ref={rootRef}
      className="device-shell__extension-layer"
      data-dimina-simulator-overlay-root
    />
  )
}

export function dispatchSimulatorCapsuleMore(
  appId: string,
  appName: string,
  pagePath: string,
): void {
  void dispatchSimulatorChromeAction({
    name: 'capsule.more',
    appId,
    appName: appName || appId,
    pagePath,
  })
}
