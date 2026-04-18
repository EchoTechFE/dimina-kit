import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: Parameters<typeof clsx>) {
  return twMerge(clsx(inputs))
}

/** Generate a consistent accent color for a project based on its name. */
export function projectColor(name: string): string {
  const colors = ['#07c160', '#1989fa', '#ee0a24', '#ff976a', '#7232dd', '#3cc51f']
  let hash = 0
  for (let i = 0; i < name.length; i++)
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return colors[Math.abs(hash) % colors.length] ?? colors[0]
}

/** Human-readable relative time for last-opened timestamps. */
export function formatLastOpened(iso: string | null | undefined): string {
  if (!iso) return '从未打开'
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return d.toLocaleDateString('zh-CN')
}
