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
  getHeaderHeight,
  hidePopover,
  onPopoverClosed,
  onPopoverRelaunch,
  showPopover,
} from '@/shared/api'
import type { CompileConfig } from '@/shared/types'

export interface UsePopoverProps {
  relaunch: (nextConfig?: CompileConfig) => Promise<void>
  compileConfig: CompileConfig
  pages: string[]
  compileDropdownRef: RefObject<HTMLDivElement | null>
}

export interface PopoverHookResult {
  showCompilePanel: boolean
  toggleCompilePanel: () => void
}

export function usePopover(props: UsePopoverProps): PopoverHookResult {
  const { relaunch, compileConfig, pages, compileDropdownRef } = props

  const [showCompilePanel, setShowCompilePanel] = useState(false)

  // Host-configured header height; HEADER_H (40) is the fallback until the
  // IPC value resolves. Fetched once, mirrors the getBranding() pattern.
  const [headerHeight, setHeaderHeight] = useState(HEADER_H)
  useEffect(() => {
    getHeaderHeight()
      .then((h) => {
        if (typeof h === 'number') setHeaderHeight(h)
      })
      .catch(() => {})
  }, [])

  const relaunchRef = useRef(relaunch)
  useEffect(() => {
    relaunchRef.current = relaunch
  }, [relaunch])

  useEffect(() => {
    const offClosed = onPopoverClosed(() => setShowCompilePanel(false))
    const offRelaunch = onPopoverRelaunch((newConfig) => {
      setShowCompilePanel(false)
      void relaunchRef.current(newConfig)
    })
    return () => {
      offClosed()
      offRelaunch()
    }
  }, [])

  const compileConfigRef = useRef(compileConfig)
  const pagesRef = useRef(pages)
  useEffect(() => {
    compileConfigRef.current = compileConfig
  }, [compileConfig])
  useEffect(() => {
    pagesRef.current = pages
  }, [pages])

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
        top: Math.round(rect.bottom - headerHeight + POPOVER_OFFSET_PX),
        left: Math.round(rect.left),
        config: compileConfigRef.current,
        pages: pagesRef.current,
      })
      return true
    })
  }, [compileDropdownRef, headerHeight])

  return {
    showCompilePanel,
    toggleCompilePanel,
  }
}
