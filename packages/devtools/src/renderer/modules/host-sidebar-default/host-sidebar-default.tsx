import { useEffect, useState } from 'react'
import { Smartphone, Gamepad2 } from 'lucide-react'
import { PROJECT_TYPE_LABEL, type ProjectType } from '@/shared/types'
import { HOST_SIDEBAR_DEFAULT_WIDTH } from '@/shared/constants'

const CATEGORIES: Array<{ type: ProjectType; icon: typeof Smartphone }> = [
  { type: 'miniprogram', icon: Smartphone },
  { type: 'minigame', icon: Gamepad2 },
]

/**
 * devtools' own default content for the host-sidebar slot: a narrow icon
 * rail selecting which project category `ProjectList` shows. Talks to main
 * ONLY through `window.diminaHostSidebar` — the same narrow bridge a
 * downstream replacement gets (host-sidebar is excluded from the trusted IPC
 * whitelist regardless of who authored the loaded content) — so this is
 * written exactly as a downstream host page would be.
 *
 * The root carries `data-host-sidebar-root` with a fixed intrinsic width
 * (not `w-full`) so the width advertiser (`host-sidebar-advertiser.ts`)
 * measures and reports `HOST_SIDEBAR_DEFAULT_WIDTH` itself, in the slot's
 * ordinary 'auto' extent mode — main does not pin the width.
 */
export default function HostSidebarDefault() {
  const [selected, setSelected] = useState<ProjectType>('miniprogram')

  // Main forces a category switch after importing a project whose detected
  // type doesn't match whatever this rail is currently showing (see
  // ipc/projects.ts's Add handler) — this rail has no other way to learn
  // about a selection that didn't originate from its own click below.
  useEffect(() => window.diminaHostSidebar?.onMessage('project-category-forced', (payload) => {
    const category = (payload as { category?: unknown } | null)?.category
    if (category === 'miniprogram' || category === 'minigame') setSelected(category)
  }), [])

  function select(type: ProjectType) {
    setSelected(type)
    window.diminaHostSidebar?.send('project-category-selected', { category: type })
  }

  return (
    <div
      data-host-sidebar-root
      className="flex flex-col items-center h-full bg-surface py-3"
      style={{ width: HOST_SIDEBAR_DEFAULT_WIDTH }}
    >
      <div className="flex flex-col gap-1 w-full px-2">
        {CATEGORIES.map(({ type, icon: Icon }) => (
          <button
            key={type}
            type="button"
            title={PROJECT_TYPE_LABEL[type]}
            aria-label={PROJECT_TYPE_LABEL[type]}
            aria-pressed={selected === type}
            onClick={() => select(type)}
            className={`flex flex-col items-center justify-center gap-1 py-2 w-full rounded-md transition-colors ${
              selected === type
                ? 'bg-surface-active text-accent'
                : 'text-text-secondary hover:bg-surface-3 hover:text-text'
            }`}
          >
            <Icon className="size-5" />
            <span className="text-[10px] leading-none">{PROJECT_TYPE_LABEL[type]}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
