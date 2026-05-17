import { useState, useEffect } from 'react'
import { ProjectList } from '@/shared/components/project-list'
import { ProjectRuntime } from '@/modules/main/features/project-runtime/project-runtime'
import { UpdateDialog } from '@/modules/update/update-dialog'
import {
  addProject,
  chooseProjectDirectory,
  getBranding,
  getThumbnail,
  listProjects,
  onWindowNavigateBack,
  removeProject,
} from '@/shared/api'
import type { Project } from '@/shared/types'

const DEFAULT_APP_NAME = 'Dimina DevTools'

export default function Main() {
  const [page, setPage] = useState('list')
  const [currentProject, setCurrentProject] = useState<Project | null>(null)
  const [projectList, setProjectList] = useState<Project[]>([])
  const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({})
  const [appName, setAppName] = useState(DEFAULT_APP_NAME)

  async function loadProjects() {
    setProjectList(await listProjects())
  }

  useEffect(() => {
    loadProjects()
    getBranding()
      .then((b) => {
        if (b?.appName) {
          setAppName(b.appName)
          document.title = b.appName
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (projectList.length === 0) return
    Promise.all(
      projectList.map((p) =>
        getThumbnail(p.path).then((t) => [p.path, t] as const),
      ),
    ).then((entries) => setThumbnails(Object.fromEntries(entries)))
  }, [projectList])

  useEffect(() => {
    const off = onWindowNavigateBack(() => {
      document.title = appName
      setPage('list')
      setCurrentProject(null)
      listProjects().then(setProjectList)
    })
    return off
  }, [appName])

  async function handleAdd() {
    const dirPath = await chooseProjectDirectory()
    if (!dirPath) return
    let project: Project
    try {
      project = await addProject(dirPath)
    } catch {
      // main 端已经通过 native dialog 提示了错误（无效的小程序目录等）
      return
    }
    await loadProjects()
    handleOpen(project)
  }

  async function handleRemove(p: Project) {
    await removeProject(p.path)
    await loadProjects()
  }

  function handleOpen(p: Project) {
    setCurrentProject(p)
    setPage('project')
  }

  if (page === 'list') {
    return (
      <>
        <UpdateDialog />
        <ProjectList projects={projectList} onAdd={handleAdd} onOpen={handleOpen} onRemove={handleRemove} thumbnails={thumbnails} />
      </>
    )
  }

  return (
    <>
      <UpdateDialog />
      <ProjectRuntime key={currentProject?.path} project={currentProject!} />
    </>
  )
}
