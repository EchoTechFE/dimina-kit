import { useState, useEffect } from 'react'
import { ProjectList } from '@/shared/components/project-list'
import { ProjectRuntime } from '@/modules/main/features/project-runtime/project-runtime'
import { UpdateDialog } from '@/modules/update/update-dialog'
import {
  addProject,
  chooseProjectDirectory,
  getBranding,
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
    const project = await addProject(dirPath)
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
        <ProjectList projects={projectList} onAdd={handleAdd} onOpen={handleOpen} onRemove={handleRemove} />
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
