import { AppChannel } from '../../shared/ipc-channels.js'
import type { HeaderActionInfo, HeaderAvatarInfo } from '../../shared/types.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { IpcRegistry } from '../utils/ipc-registry.js'

type AppIpcContext = Pick<
  WorkbenchContext,
  | 'brandingProvider'
  | 'appName'
  | 'headerAvatarProvider'
  | 'headerAvatarActionHandler'
  | 'headerActionsProvider'
  | 'headerActionHandler'
  | 'senderPolicy'
>

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeHeaderAvatar(value: unknown): HeaderAvatarInfo | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const avatar: HeaderAvatarInfo = {}

  const displayName = readString(raw.displayName)
  const displayInitial = readString(raw.displayInitial)
  const avatarUrl = readString(raw.avatarUrl)
  const tooltip = readString(raw.tooltip)

  if (displayName) avatar.displayName = displayName
  if (displayInitial) avatar.displayInitial = displayInitial
  if (avatarUrl) avatar.avatarUrl = avatarUrl
  if (tooltip) avatar.tooltip = tooltip

  return avatar.displayName || avatar.displayInitial || avatar.avatarUrl ? avatar : null
}

function normalizeHeaderAction(value: unknown): HeaderActionInfo | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = readString(raw.id)
  const label = readString(raw.label)
  if (!id || !label) return null

  const action: HeaderActionInfo = { id, label }
  const placement = readString(raw.placement)
  const icon = readString(raw.icon)
  const tooltip = readString(raw.tooltip)

  if (placement === 'left' || placement === 'center' || placement === 'right') {
    action.placement = placement
  }
  if (icon) action.icon = icon
  if (tooltip) action.tooltip = tooltip
  if (typeof raw.disabled === 'boolean') action.disabled = raw.disabled

  return action
}

function normalizeHeaderActions(value: unknown): HeaderActionInfo[] {
  if (!Array.isArray(value)) return []

  const ids = new Set<string>()
  const actions: HeaderActionInfo[] = []
  for (const item of value) {
    const action = normalizeHeaderAction(item)
    if (!action || ids.has(action.id)) continue
    ids.add(action.id)
    actions.push(action)
  }
  return actions
}

export function registerAppIpc(ctx: AppIpcContext): Disposable {
  return new IpcRegistry(ctx.senderPolicy)
    .handle(AppChannel.GetBranding, async () => {
      if (ctx.brandingProvider) return ctx.brandingProvider()
      return { appName: ctx.appName }
    })
    .handle(AppChannel.GetHeaderAvatar, async () => {
      if (!ctx.headerAvatarProvider) return null
      return normalizeHeaderAvatar(await ctx.headerAvatarProvider())
    })
    .handle(AppChannel.InvokeHeaderAvatar, async () => {
      await ctx.headerAvatarActionHandler?.()
    })
    .handle(AppChannel.GetHeaderActions, async () => {
      if (!ctx.headerActionsProvider) return []
      return normalizeHeaderActions(await ctx.headerActionsProvider())
    })
    .handle(AppChannel.InvokeHeaderAction, async (_event, id: unknown) => {
      if (typeof id !== 'string' || !id) return
      await ctx.headerActionHandler?.(id)
    })
}
