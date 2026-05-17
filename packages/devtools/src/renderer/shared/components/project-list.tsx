import { useState, useMemo } from 'react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Search } from 'lucide-react'
import { ProjectCard } from './project-card'
import type { Project } from '../types'

export function ProjectList({
  projects,
  onAdd,
  onOpen,
  onRemove,
  thumbnails,
}: {
  projects: Project[]
  onAdd: () => void
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

  return (
    <div className="flex flex-col h-screen bg-bg">
      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-6 gap-4">
          <div className="flex items-center flex-1 max-w-xs min-w-0">
            <div className="relative w-full">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-secondary pointer-events-none" />
              <Input
                placeholder="搜索"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full h-8 pl-8 pr-3 rounded-md text-sm"
              />
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onAdd}
            className="shrink-0 text-accent hover:text-accent-hover hover:bg-transparent"
          >
            导入
          </Button>
        </div>
        {projects.length > 0 ? (
          filtered.length > 0 ? (
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
            >
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
          ) : (
            <div className="flex flex-col items-center justify-center h-72 text-text-dim gap-3">
              <span className="text-5xl opacity-40">🔍</span>
              <span className="text-sm">未找到匹配的项目</span>
            </div>
          )
        ) : (
          <div className="flex flex-col items-center justify-center h-72 text-text-dim gap-3">
            <span className="text-5xl opacity-40">📁</span>
            <span className="text-sm">暂无项目，点击「导入」添加</span>
          </div>
        )}
      </div>
    </div>
  )
}
