import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  notifyOverlayReady,
  onTooltipInit,
  reportTooltipMeasured,
  type TooltipRenderPayload,
} from '@/shared/api'

/** Renderer for the top-tier native tooltip surface. */
export default function Tooltip() {
  const [request, setRequest] = useState<TooltipRenderPayload | null>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const off = onTooltipInit(setRequest)
    notifyOverlayReady()
    return off
  }, [])

  useLayoutEffect(() => {
    const surface = surfaceRef.current
    if (!surface || !request) return
    const rect = surface.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    reportTooltipMeasured({
      requestId: request.requestId,
      width: Math.ceil(rect.width),
      height: Math.ceil(rect.height),
    })
  }, [request])

  return (
    <div
      ref={surfaceRef}
      className="inline-flex w-max p-1"
      style={{ maxWidth: request?.maxWidth }}
    >
      <div className="max-w-full whitespace-normal break-words rounded-[var(--qd-radius-md)] bg-[var(--qd-foreground)] px-3 py-1.5 text-xs text-[color:var(--qd-background)] shadow-[var(--qd-shadow-md)]">
        {request?.text ?? ''}
      </div>
    </div>
  )
}
