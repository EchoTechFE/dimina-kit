import React from 'react'
import { cn } from '@/shared/lib/utils'

const Input = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<'input'> & { className?: string }
>(({ className, type = 'text', ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      'h-[var(--qd-control-h)] w-full min-w-0 rounded-[var(--qd-radius-md)] border border-solid border-[var(--qd-border)] bg-[var(--qd-background)] text-text placeholder:text-text-secondary shadow-[var(--qd-shadow-control)]',
      'px-3 py-1 text-[13px]',
      'focus:outline-none focus:border-[var(--qd-primary)]',
      'disabled:opacity-50 disabled:cursor-not-allowed',
      className
    )}
    {...props}
  />
))
Input.displayName = 'Input'

export { Input }
