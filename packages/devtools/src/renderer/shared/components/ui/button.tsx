import * as React from 'react'
import type { VariantProps } from 'class-variance-authority'
import { cva } from 'class-variance-authority'
import { Slot } from '@radix-ui/react-slot'

import { cn } from '@/shared/lib/utils'

// Base = Cornetto @cornetto-react/button (three-slot: --btn-bg face /
// --btn-fg text+icon / --btn-border frame — override the slots to reskin
// without touching the component). `icon`/`danger`/`xs`/`icon-sm` are local
// additions Cornetto doesn't ship (devtools' toolbar density needs a
// tighter scale than Cornetto's --qd-btn-h baseline); `tab`/`tab-active`
// are carried over unused from the pre-Cornetto button — no call site
// references them, kept only to avoid a silent behavior change for any
// caller found later.
export const buttonVariants = cva(
  'inline-flex appearance-none items-center justify-center gap-1 whitespace-nowrap rounded-[var(--qd-radius-md)] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--qd-primary)] disabled:pointer-events-none disabled:opacity-50 border-solid [border-width:var(--qd-border-width)] text-[color:var(--btn-fg)] bg-[var(--btn-bg)] border-[var(--btn-border)] [--qd-icon-size:1em]',
  {
    variants: {
      variant: {
        default:     '[--btn-fg:var(--qd-on-solid)] [--btn-bg:var(--qd-primary)] [--btn-border:transparent] hover:opacity-90',
        soft:        '[--btn-fg:var(--qd-primary)] [--btn-bg:var(--qd-primary-soft)] [--btn-border:transparent] hover:opacity-90',
        secondary:   '[--btn-fg:var(--qd-secondary-foreground)] [--btn-bg:var(--qd-secondary)] [--btn-border:transparent] hover:opacity-90',
        outline:     '[--btn-fg:var(--qd-foreground)] [--btn-bg:var(--qd-background)] [--btn-border:var(--qd-border)] hover:[background-color:var(--qd-muted)]',
        ghost:       '[--btn-fg:var(--qd-foreground)] [--btn-bg:transparent] [--btn-border:transparent] hover:[background-color:var(--qd-muted)]',
        destructive: '[--btn-fg:var(--qd-on-solid)] [--btn-bg:var(--qd-destructive)] [--btn-border:transparent] hover:opacity-90',
        link:        '[--btn-fg:var(--qd-primary)] [--btn-bg:transparent] [--btn-border:transparent] underline-offset-4 hover:underline',
        // devtools-local — no Cornetto equivalent
        icon:        'rounded [--btn-fg:var(--qd-muted-foreground)] [--btn-bg:transparent] [--btn-border:transparent] hover:[background-color:var(--qd-muted)] hover:[--btn-fg:var(--qd-foreground)]',
        danger:      'rounded-full [--btn-fg:var(--qd-muted-foreground)] [--btn-bg:transparent] [--btn-border:transparent] hover:[--btn-fg:var(--qd-destructive)] hover:[background-color:var(--qd-destructive-soft)]',
        // dead: no call site references these (pre-Cornetto leftover)
        tab:         'rounded text-text-muted hover:text-text hover:bg-surface-3',
        'tab-active': 'rounded text-text bg-surface-active',
      },
      size: {
        default: 'h-[var(--qd-btn-h)] px-4 py-2 text-sm',
        sm: 'h-[calc(var(--qd-btn-h)-4px)] px-3 text-xs',
        lg: 'h-[calc(var(--qd-btn-h)+4px)] px-6 text-base',
        icon: 'size-[var(--qd-btn-h)] text-base',
        // devtools-local — tighter than Cornetto's --qd-btn-h baseline for toolbar density
        xs: 'h-5 px-2 text-[11px]',
        'icon-sm': 'h-6 w-6 p-0 text-[14px]',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)
export type ButtonVariants = VariantProps<typeof buttonVariants>

const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> & ButtonVariants & { asChild?: boolean }
>(function Button({ className, variant, size, asChild = false, type, ...props }, ref) {
  const Comp = asChild ? Slot : 'button'
  const elementProps = asChild
    ? (type === undefined ? props : { type, ...props })
    : { type: type ?? 'button', ...props }

  return (
    <Comp
      ref={ref}
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...elementProps}
    />
  )
})

export { Button }
