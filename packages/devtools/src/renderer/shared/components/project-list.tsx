import { useState, useMemo } from 'react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { FolderInput, Search } from 'lucide-react'
import { ProjectCard } from './project-card'
import { ProjectCreateCard } from './project-create-card'
import type { Project } from '../types'

export function ProjectList({
  projects,
  onAdd,
  onCreate,
  onOpen,
  onRemove,
  thumbnails,
}: {
  projects: Project[]
  onAdd: () => void
  /**
   * Invoked when the always-present "新建小程序" card is clicked. The card is
   * rendered as the first item of the grid and is shown even when the
   * project list is empty.
   */
  onCreate?: () => void
  onOpen: (p: Project) => void
  onRemove: (p: Project) => void
  thumbnails?: Record<string, string | null>
}) {
  const [search, setSearch] = useState('')
  const filtered = useMemo(() => {
    if (!search.trim()) return projects
    const q = search.trim().toLowerCase()
    return projects.filter(
      (p) =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.path || '').toLowerCase().includes(q)
    )
  }, [projects, search])

  const handleCreate = onCreate ?? (() => {})
  const noMatch = projects.length > 0 && filtered.length === 0

  return (
    <div className="flex flex-col h-screen bg-bg">
      <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between w-full shrink-0">
          <h1 className="text-2xl font-medium leading-8 text-text">小程序</h1>
          <Button
            variant="outline"
            onClick={onAdd}
            className="h-9 gap-2 px-2.5 text-[15px]"
          >
            <FolderInput className="size-4" />
            导入
          </Button>
        </div>
        <div className="flex items-center gap-2 h-8 px-3 rounded-[8px] bg-surface w-[300px] shrink-0">
          <Search className="size-4 text-text-secondary shrink-0" />
          <Input
            placeholder="搜索"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-0 h-auto border-0 shadow-none bg-transparent px-0 py-0 text-[13px]"
          />
        </div>
        {noMatch ? (
          <div className="flex flex-col items-center justify-center h-72 text-text-dim gap-3">
            <span className="text-5xl opacity-40">🔍</span>
            <span className="text-sm">未找到匹配的项目</span>
          </div>
        ) : (
          <div
            className="grid gap-4 w-full"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}
          >
            {/*
              The create card is always the first item (even when projects
              is empty) so first-time users have an obvious next step.
              Search doesn't filter the create card — it's not a project.
            */}
            <ProjectCreateCard onClick={handleCreate} />
            {filtered.map((p) => (
              <ProjectCard
                key={p.path}
                project={p}
                onOpen={onOpen}
                onRemove={onRemove}
                thumbnail={thumbnails?.[p.path]}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
