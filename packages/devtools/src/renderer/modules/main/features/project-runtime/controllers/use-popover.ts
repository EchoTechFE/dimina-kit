import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { RefObject } from 'react'
import {
  HEADER_H,
  POPOVER_OFFSET_PX,
} from '@/shared/constants'
import {
  hidePopover,
  onPopoverClosed,
  onPopoverRelaunch,
  onPopoverSwitchLaunchConfig,
  onPopoverUpdateLaunchConfigs,
  showPopover,
} from '@/shared/api'
import type { CompileConfig, LaunchConfig } from '@/shared/types'

export interface UsePopoverProps {
  relaunch: (nextConfig?: CompileConfig) => Promise<void>
  compileConfig: CompileConfig
  pages: string[]
  compileDropdownRef: RefObject<HTMLDivElement | null>
  launchConfigs: LaunchConfig[]
  activeLaunchConfigId: string | null
  switchLaunchConfig: (id: string | null) => Promise<void>
  updateLaunchConfigs: (configs: LaunchConfig[]) => Promise<void>
}

export interface PopoverHookResult {
  showCompilePanel: boolean
  toggleCompilePanel: () => void
}

export function usePopover(props: UsePopoverProps): PopoverHookResult {
  const {
    relaunch,
    compileConfig,
    pages,
    compileDropdownRef,
    launchConfigs,
    activeLaunchConfigId,
    switchLaunchConfig,
    updateLaunchConfigs,
  } = props

  const [showCompilePanel, setShowCompilePanel] = useState(false)

  const relaunchRef = useRef(relaunch)
  useEffect(() => {
    relaunchRef.current = relaunch
  }, [relaunch])

  const switchLaunchConfigRef = useRef(switchLaunchConfig)
  useEffect(() => {
    switchLaunchConfigRef.current = switchLaunchConfig
  }, [switchLaunchConfig])

  const updateLaunchConfigsRef = useRef(updateLaunchConfigs)
  useEffect(() => {
    updateLaunchConfigsRef.current = updateLaunchConfigs
  }, [updateLaunchConfigs])

  useEffect(() => {
    const offClosed = onPopoverClosed(() => setShowCompilePanel(false))
    const offRelaunch = onPopoverRelaunch((newConfig) => {
      setShowCompilePanel(false)
      void relaunchRef.current(newConfig)
    })
    const offSwitch = onPopoverSwitchLaunchConfig((id) => {
      setShowCompilePanel(false)
      void switchLaunchConfigRef.current(id)
    })
    const offUpdate = onPopoverUpdateLaunchConfigs((configs) => {
      void updateLaunchConfigsRef.current(configs)
    })
    return () => {
      offClosed()
      offRelaunch()
      offSwitch()
      offUpdate()
    }
  }, [])

  const compileConfigRef = useRef(compileConfig)
  const pagesRef = useRef(pages)
  const launchConfigsRef = useRef(launchConfigs)
  const activeLaunchConfigIdRef = useRef(activeLaunchConfigId)
  useEffect(() => {
    compileConfigRef.current = compileConfig
  }, [compileConfig])
  useEffect(() => {
    pagesRef.current = pages
  }, [pages])
  useEffect(() => {
    launchConfigsRef.current = launchConfigs
  }, [launchConfigs])
  useEffect(() => {
    activeLaunchConfigIdRef.current = activeLaunchConfigId
  }, [activeLaunchConfigId])

  const toggleCompilePanel = useCallback(() => {
    setShowCompilePanel((prev) => {
      if (prev) {
        void hidePopover()
        return false
      }
      const el = compileDropdownRef.current
      if (!el) return prev
      const rect = el.getBoundingClientRect()
      void showPopover({
        top: Math.round(rect.bottom - HEADER_H + POPOVER_OFFSET_PX),
        left: Math.round(rect.left),
        config: compileConfigRef.current,
        pages: pagesRef.current,
        launchConfigs: launchConfigsRef.current,
        activeLaunchConfigId: activeLaunchConfigIdRef.current,
      })
      return true
    })
  }, [compileDropdownRef])

  return {
    showCompilePanel,
    toggleCompilePanel,
  }
}
