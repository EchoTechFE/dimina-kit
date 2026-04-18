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
      'bg-surface border border-border text-text placeholder-text-dim',
      'px-1.5 py-0.5 rounded text-[12px]',
      'focus:outline-none focus:border-accent',
      'disabled:opacity-40 disabled:cursor-not-allowed',
      className
    )}
    {...props}
  />
))
Input.displayName = 'Input'

export { Input }
