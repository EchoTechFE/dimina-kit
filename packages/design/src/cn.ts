import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Join class names, letting a later Tailwind utility win over an earlier one
 * in the same group (`cn('p-2', 'p-4')` → `'p-4'`). Without the merge step a
 * component's default padding and a caller's override would both survive and
 * the winner would depend on stylesheet order.
 */
export function cn(...inputs: Parameters<typeof clsx>) {
  return twMerge(clsx(inputs))
}
