/**
 * Minimal collapsible file tree built from a flat list of POSIX-relative
 * paths (as returned by `listProjectFiles`). No virtualization — the
 * `listFiles` cap (5000) keeps the node count bounded.
 */
import { useMemo, useState, type ReactNode } from 'react'

interface TreeNode {
  name: string
  path: string
  children?: Map<string, TreeNode>
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map() }
  for (const p of paths) {
    const parts = p.split('/')
    let node = root
    let acc = ''
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      acc = acc ? `${acc}/${part}` : part
      const isFile = i === parts.length - 1
      if (!node.children) node.children = new Map()
      let child = node.children.get(part)
      if (!child) {
        child = { name: part, path: acc, children: isFile ? undefined : new Map() }
        node.children.set(part, child)
      }
      node = child
    }
  }
  return root
}

function sortedChildren(node: TreeNode): TreeNode[] {
  if (!node.children) return []
  return Array.from(node.children.values()).sort((a, b) => {
    const aDir = a.children ? 0 : 1
    const bDir = b.children ? 0 : 1
    if (aDir !== bDir) return aDir - bDir // folders first
    return a.name.localeCompare(b.name)
  })
}

interface FileTreeProps {
  files: string[]
  activePath: string | null
  onOpen: (path: string) => void
}

export function FileTree({ files, activePath, onOpen }: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files])
  return (
    <div className="h-full w-full overflow-auto text-[13px] leading-6 select-none py-1">
      {sortedChildren(tree).map((n) => (
        <TreeRow key={n.path} node={n} depth={0} activePath={activePath} onOpen={onOpen} />
      ))}
    </div>
  )
}

function TreeRow({
  node,
  depth,
  activePath,
  onOpen,
}: {
  node: TreeNode
  depth: number
  activePath: string | null
  onOpen: (path: string) => void
}): ReactNode {
  const [open, setOpen] = useState(depth < 1)
  const isFolder = !!node.children
  const isActive = !isFolder && node.path === activePath
  const pad = { paddingLeft: 8 + depth * 12 }

  if (isFolder) {
    return (
      <div>
        <div
          className="flex items-center gap-1 cursor-pointer hover:bg-black/5 dark:hover:bg-white/10 truncate"
          style={pad}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="opacity-60 w-3 inline-block">{open ? '▾' : '▸'}</span>
          <span className="truncate">{node.name}</span>
        </div>
        {open &&
          sortedChildren(node).map((c) => (
            <TreeRow key={c.path} node={c} depth={depth + 1} activePath={activePath} onOpen={onOpen} />
          ))}
      </div>
    )
  }

  return (
    <div
      className={
        'flex items-center gap-1 cursor-pointer truncate ' +
        (isActive ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300' : 'hover:bg-black/5 dark:hover:bg-white/10')
      }
      style={pad}
      onClick={() => onOpen(node.path)}
      title={node.path}
    >
      <span className="w-3 inline-block" />
      <span className="truncate">{node.name}</span>
    </div>
  )
}
