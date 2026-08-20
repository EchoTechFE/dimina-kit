import { useEffect, useState } from 'react'
import { onTooltipInit } from '@/shared/api'

/**
 * The tooltip overlay's own renderer. Main computes the WCV's absolute
 * bounds (see `computeTooltipBounds`) — this page just fills that box and
 * renders whatever label it was last pushed via `tooltip:init`. See
 * `TooltipChannel`'s doc-comment (ipc-channels.ts) for why this exists as a
 * separate WebContentsView instead of DOM/native tooltip UI in the main
 * window.
 */
export default function Tooltip() {
  const [text, setText] = useState('')

  useEffect(() => onTooltipInit((payload) => setText(payload.text)), [])

  return (
    <div className="flex size-full items-center justify-center p-1">
      <div className="max-w-full truncate rounded-[var(--qd-radius-md)] bg-[var(--qd-foreground)] px-3 py-1.5 text-xs text-[color:var(--qd-background)] shadow-[var(--qd-shadow-md)]">
        {text}
      </div>
    </div>
  )
}
