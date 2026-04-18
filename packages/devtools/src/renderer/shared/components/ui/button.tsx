import React from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '@/shared/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 font-medium transition-colors focus:outline-none disabled:opacity-35 disabled:cursor-not-allowed whitespace-nowrap shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-accent text-text-white hover:bg-accent-hover rounded',
        ghost:
          'text-text-secondary hover:bg-surface-3 hover:text-text rounded',
        outline:
          'border border-border text-text-muted hover:border-border-subtle hover:text-text rounded',
        icon:
          'text-text-secondary hover:bg-surface-3 hover:text-text-muted rounded',
        tab:
          'text-text-muted hover:text-text hover:bg-surface-3 rounded',
        'tab-active':
          'text-text bg-surface-active rounded',
        danger:
          'border border-transparent text-text-secondary hover:text-status-error hover:bg-danger-bg rounded-full',
      },
      size: {
        default: 'h-7 px-4 text-[13px]',
        sm: 'h-6 px-3 text-[12px]',
        xs: 'h-5 px-2 text-[11px]',
        icon: 'h-7 w-7 p-0 text-[15px]',
        'icon-sm': 'h-6 w-6 p-0 text-[14px]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

type ButtonProps = React.ComponentProps<'button'> & {
  variant?: 'default' | 'ghost' | 'outline' | 'icon' | 'tab' | 'tab-active' | 'danger'
  size?: 'default' | 'sm' | 'xs' | 'icon' | 'icon-sm'
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button
    ref={ref}
    className={cn(buttonVariants({ variant, size }), className)}
    {...props}
  />
))
Button.displayName = 'Button'

export { Button, buttonVariants }
