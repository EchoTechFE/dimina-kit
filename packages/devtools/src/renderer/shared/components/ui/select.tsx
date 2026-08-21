import React from 'react'
import { cn } from '@/shared/lib/utils'

/**
 * Lightweight native <select> wrapper styled to match the design system.
 * For the complex Radix Select, use SelectRoot/SelectContent from
 * @radix-ui/react-select directly.
 */
const Select = React.forwardRef<
  HTMLSelectElement,
  React.ComponentProps<'select'> & { className?: string }
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'bg-surface border border-border text-text-secondary',
      'h-7 px-2 rounded-[var(--qd-radius-md)] text-[13px] font-medium cursor-pointer',
      'focus:outline-none focus:border-accent',
      className
    )}
    {...props}
  >
    {children}
  </select>
))
Select.displayName = 'Select'

export { Select }
