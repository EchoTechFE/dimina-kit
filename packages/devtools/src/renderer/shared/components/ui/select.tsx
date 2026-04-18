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
      'px-1.5 py-0.5 rounded text-[11px] cursor-pointer',
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
