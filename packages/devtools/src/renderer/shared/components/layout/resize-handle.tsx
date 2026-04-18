import { Separator } from "react-resizable-panels"

import { cn } from "@/shared/lib/utils"

interface ResizeHandleProps {
  className?: string
  direction?: "horizontal" | "vertical"
}

export function ResizeHandle({
  className,
  direction = "horizontal",
}: ResizeHandleProps) {
  const isHorizontal = direction === "horizontal"

  return (
    <Separator
      className={cn(
        "group relative flex items-center justify-center bg-border",
        isHorizontal ? "w-px" : "h-px",
        "data-[resize-handle-active]:bg-ring",
        className
      )}
    >
      <div
        className={cn(
          "absolute z-10 rounded-full bg-border transition-colors group-hover:bg-ring group-data-[resize-handle-active]:bg-ring",
          isHorizontal
            ? "h-8 w-1 cursor-col-resize"
            : "h-1 w-8 cursor-row-resize"
        )}
      />
    </Separator>
  )
}
