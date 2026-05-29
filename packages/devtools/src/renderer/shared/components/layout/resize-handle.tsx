import { Separator } from "react-resizable-panels"

import { cn } from "@/shared/lib/utils"
import {
  splitterHitArea,
  splitterVisibleBar,
} from "@/shared/components/layout/splitter-styles"

interface ResizeHandleProps {
  className?: string
  direction?: "horizontal" | "vertical"
}

/**
 * Resize handle for `react-resizable-panels` groups (editor / debug, etc.).
 *
 * Shares its hit-area + visible-bar styling with the manual sim-column
 * `Splitter` (see `splitter-styles`) so every divider in the workbench
 * reads as the same 1px line with a wide invisible drag zone and the same
 * border → ring hover/active color.
 */
export function ResizeHandle({
  className,
  direction = "horizontal",
}: ResizeHandleProps) {
  const orientation = direction === "horizontal" ? "vertical" : "horizontal"

  return (
    <Separator className={cn(splitterHitArea(orientation), className)}>
      <div
        className={cn(
          splitterVisibleBar,
          // `react-resizable-panels` toggles this attribute while dragging;
          // map it to the same ring color as hover so active feels unified.
          "group-data-[resize-handle-active]:bg-ring",
          orientation === "vertical" ? "h-full w-px" : "h-px w-full"
        )}
      />
    </Separator>
  )
}
