import { useState, useEffect } from 'react'
import { ProjectList } from '@/shared/components/project-list'
import { ProjectCreateDialog } from '@/shared/components/project-create-dialog'
import type { ProjectTemplateInfo } from '@/shared/components/project-create-dialog'
import { ProjectRuntime } from '@/modules/main/features/project-runtime/project-runtime'
import { UpdateDialog } from '@/modules/update/update-dialog'
import {
  addProject,
  chooseProjectDirectory,
  createProject,
  getBranding,
  getCreateProjectDefaults,
  getThumbnail,
  listProjects,
  listTemplates,
  onWindowNavigateBack,
  openCreateProjectDialog,
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

  // Phase 4: local "新建项目" dialog state. Used only when the host did
  // not supply a customCreateProjectDialog hook (openCreateProjectDialog
  // returns null in that case).
  const [createOpen, setCreateOpen] = useState(false)
  const [createTemplates, setCreateTemplates] = useState<ProjectTemplateInfo[]>([])
  const [createBaseDir, setCreateBaseDir] = useState<string>('')

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

  async function handleCreate() {
    // First try the host-supplied dialog (qdmp/etc.). It can return:
    //   null              → user cancelled or no host hook → use built-in
    //   { ready: Project} → host already created the project, just refresh
    //   CreateProjectInput→ host collected inputs, we materialise the template
    let result: Awaited<ReturnType<typeof openCreateProjectDialog>>
    try {
      result = await openCreateProjectDialog()
    } catch {
      result = null
    }

    if (result && 'ready' in result) {
      // Host backend already created the project; just refresh and open.
      await loadProjects()
      handleOpen(result.ready)
      return
    }

    if (result) {
      // CreateProjectInput shape — run our scaffold flow. Errors here are
      // surfaced by the main process via a native dialog (mirroring the
      // Add flow), so the renderer only needs to bail out quietly.
      let project: Project
      try {
        project = await createProject(result)
      } catch {
        return
      }
      await loadProjects()
      handleOpen(project)
      return
    }

    // Built-in path: fetch the merged catalog and the suggested base dir
    // in parallel, then open the local dialog.
    const [tplsResult, defaultsResult] = await Promise.allSettled([
      listTemplates(),
      getCreateProjectDefaults(),
    ])
    setCreateTemplates(
      tplsResult.status === 'fulfilled' ? tplsResult.value : [],
    )
    setCreateBaseDir(
      defaultsResult.status === 'fulfilled' ? defaultsResult.value.baseDir : '',
    )
    setCreateOpen(true)
  }

  async function handleCreateSubmit(input: {
    name: string
    path: string
    templateId: string
  }) {
    setCreateOpen(false)
    let project: Project
    try {
      // Errors surfaced via native dialog from the main process; bail quietly.
      project = await createProject(input)
    } catch {
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
        <ProjectList
          projects={projectList}
          onAdd={handleAdd}
          onCreate={handleCreate}
          onOpen={handleOpen}
          onRemove={handleRemove}
          thumbnails={thumbnails}
        />
        <ProjectCreateDialog
          open={createOpen}
          templates={createTemplates}
          defaultBaseDir={createBaseDir}
          onSubmit={handleCreateSubmit}
          onCancel={() => setCreateOpen(false)}
          onBrowse={chooseProjectDirectory}
        />
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
