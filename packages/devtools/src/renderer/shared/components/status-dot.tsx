import { cn } from '@/shared/lib/utils'

const colorMap: Record<string, string> = {
  compiling: 'bg-status-warn animate-[pulse_1s_infinite]',
  ready: 'bg-accent',
  error: 'bg-status-error',
}

export function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'w-1.5 h-1.5 rounded-full shrink-0',
        colorMap[status] ?? 'bg-border'
      )}
    />
  )
}
