import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "@/shared/lib/utils"

// Base = Cornetto @cornetto-react/tabs — two variants (underline default /
// segment pill), dispatched via context so List/Trigger don't need the prop
// threaded through every call site.
type TabsVariant = "underline" | "segment"
const TabsVariantContext = React.createContext<TabsVariant>("underline")

const LIST: Record<TabsVariant, string> = {
  underline: "inline-flex items-center gap-4 border-b border-solid border-[var(--qd-border)]",
  segment: "inline-flex h-[var(--qd-chip-h)] w-fit items-center justify-center rounded-lg bg-[var(--qd-muted)] p-[3px] text-text-secondary",
}
const TRIGGER: Record<TabsVariant, string> = {
  underline: "relative -mb-px inline-flex h-[var(--qd-chip-h)] appearance-none items-center justify-center gap-1.5 whitespace-nowrap border-b-2 border-solid border-transparent bg-transparent px-1 text-sm font-medium text-text-secondary transition-colors outline-none focus-visible:text-text disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-[var(--qd-primary)] data-[state=active]:text-text",
  segment: "inline-flex h-[calc(100%-1px)] flex-1 appearance-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-solid border-transparent bg-transparent px-3 py-1 text-sm font-medium text-text-secondary transition-colors outline-none focus-visible:border-[var(--qd-primary)] disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-text data-[state=active]:bg-[var(--qd-background)] data-[state=active]:shadow-sm",
}

function Tabs({
  className,
  variant = "underline",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root> & { variant?: TabsVariant }) {
  return (
    <TabsVariantContext.Provider value={variant}>
      <TabsPrimitive.Root className={cn("flex flex-col gap-2", className)} {...props} />
    </TabsVariantContext.Provider>
  )
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  const variant = React.useContext(TabsVariantContext)
  return <TabsPrimitive.List className={cn(LIST[variant], className)} {...props} />
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const variant = React.useContext(TabsVariantContext)
  return <TabsPrimitive.Trigger className={cn(TRIGGER[variant], className)} {...props} />
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("flex-1 outline-none", className)} {...props} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
