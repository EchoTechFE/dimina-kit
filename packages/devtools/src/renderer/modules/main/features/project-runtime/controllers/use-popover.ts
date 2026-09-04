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
  showPopover,
} from '@/shared/api'

export interface UsePopoverProps {
  pages: string[]
  /** What 普通编译 launches — shown in the menu and used for new modes. */
  entryPagePath: string
  /** The simulator's visible route, backing 以当前页面新建编译模式. */
  currentRoute: string
  compileDropdownRef: RefObject<HTMLDivElement | null>
}

export interface PopoverHookResult {
  showCompilePanel: boolean
  toggleCompilePanel: () => void
}

export function usePopover(props: UsePopoverProps): PopoverHookResult {
  const {
    pages,
    entryPagePath,
    currentRoute,
    compileDropdownRef,
  } = props

  const [showCompilePanel, setShowCompilePanel] = useState(false)

  useEffect(() => {
    return onPopoverClosed(() => setShowCompilePanel(false))
  }, [])

  // The popover is a separate view fed a one-shot payload, so the toggle
  // callback must read the LATEST session state without re-creating itself on
  // every session change (the toolbar button holds one reference).
  const payloadRef = useRef({ pages, entryPagePath, currentRoute })
  useEffect(() => {
    payloadRef.current = { pages, entryPagePath, currentRoute }
  }, [pages, entryPagePath, currentRoute])

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
        pages: payloadRef.current.pages,
        entryPagePath: payloadRef.current.entryPagePath,
        currentRoute: payloadRef.current.currentRoute,
      })
      return true
    })
  }, [compileDropdownRef])

  return {
    showCompilePanel,
    toggleCompilePanel,
  }
}
