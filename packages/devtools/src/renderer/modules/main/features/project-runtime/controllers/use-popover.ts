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
  onPopoverApply,
  onPopoverClosed,
  showPopover,
} from '@/shared/api'
import type { CompileModes } from '@/shared/types'

export interface UsePopoverProps {
  applyCompileModes: (modes: CompileModes, relaunch: boolean) => Promise<void>
  compileModes: CompileModes
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
    applyCompileModes,
    compileModes,
    pages,
    entryPagePath,
    currentRoute,
    compileDropdownRef,
  } = props

  const [showCompilePanel, setShowCompilePanel] = useState(false)

  const applyRef = useRef(applyCompileModes)
  useEffect(() => {
    applyRef.current = applyCompileModes
  }, [applyCompileModes])

  useEffect(() => {
    const offClosed = onPopoverClosed(() => setShowCompilePanel(false))
    const offApply = onPopoverApply(({ modes, relaunch }) => {
      setShowCompilePanel(false)
      void applyRef.current(modes, relaunch)
    })
    return () => {
      offClosed()
      offApply()
    }
  }, [])

  // The popover is a separate view fed a one-shot payload, so the toggle
  // callback must read the LATEST session state without re-creating itself on
  // every session change (the toolbar button holds one reference).
  const payloadRef = useRef({ compileModes, pages, entryPagePath, currentRoute })
  useEffect(() => {
    payloadRef.current = { compileModes, pages, entryPagePath, currentRoute }
  }, [compileModes, pages, entryPagePath, currentRoute])

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
        modes: payloadRef.current.compileModes,
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
