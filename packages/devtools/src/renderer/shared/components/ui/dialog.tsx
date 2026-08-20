import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/shared/lib/utils"

// Base = Cornetto @cornetto-react/dialog — centered modal on radix Dialog,
// scroll-safe viewport wrapper so tall content clamps to the window instead
// of overflowing it.
function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root {...props} />
}

function DialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger {...props} />
}

function DialogPortal(props: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal {...props} />
}

function DialogClose({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close className={cn("appearance-none", className)} {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-[var(--color-overlay-heavy)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

interface DialogContentProps extends React.ComponentProps<typeof DialogPrimitive.Content> {
  container?: React.ComponentProps<typeof DialogPrimitive.Portal>["container"]
}

function DialogContent({ className, children, container, ...props }: DialogContentProps) {
  return (
    <DialogPortal container={container}>
      <DialogOverlay />
      <div className="pointer-events-none fixed inset-0 z-50 flex overflow-x-hidden overflow-y-auto p-4">
        <DialogPrimitive.Content
          className={cn(
            "pointer-events-auto relative m-auto flex max-h-[calc(100dvh-2rem)] min-h-0 w-full max-w-lg flex-col gap-4 overflow-x-hidden overflow-y-auto",
            "border border-solid border-[var(--qd-border)] bg-[var(--qd-background)] text-text p-6 rounded-lg shadow-[var(--qd-shadow-lg)]",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
          <DialogPrimitive.Close
            className="absolute right-4 top-4 inline-flex size-6 items-center justify-center rounded-sm border-0 bg-transparent text-text-secondary transition-colors outline-none hover:bg-[var(--qd-muted)] hover:text-text disabled:pointer-events-none"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </div>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex shrink-0 flex-col gap-1.5 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-lg font-semibold leading-none text-text", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("text-sm text-text-secondary", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
