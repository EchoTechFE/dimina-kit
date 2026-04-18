import type { ReactNode } from "react"
import { Panel, Group } from "react-resizable-panels"

import { cn } from "@/shared/lib/utils"

import { ResizeHandle } from "./resize-handle"

export interface WorkbenchLayoutProps {
  /** Content for the left simulator panel */
  simulator: ReactNode
  /** Content for the center editor/code panel */
  editor: ReactNode
  /** Content for the right debug tools panel */
  debugTools: ReactNode
  className?: string
}

export function WorkbenchLayout({
  simulator,
  editor,
  debugTools,
  className,
}: WorkbenchLayoutProps) {
  return (
    <Group
      orientation="horizontal"
      className={cn("h-full w-full", className)}
    >
      <Panel
        defaultSize={30}
        minSize={15}
        className="overflow-hidden"
      >
        {simulator}
      </Panel>

      <ResizeHandle direction="horizontal" />

      <Panel
        defaultSize={40}
        minSize={20}
        className="overflow-hidden"
      >
        {editor}
      </Panel>

      <ResizeHandle direction="horizontal" />

      <Panel
        defaultSize={30}
        minSize={15}
        className="overflow-hidden"
      >
        {debugTools}
      </Panel>
    </Group>
  )
}
