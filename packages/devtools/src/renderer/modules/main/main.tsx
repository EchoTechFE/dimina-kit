import { useState, useEffect } from 'react'
import { ProjectListScreen } from '@/modules/main/features/project-list/project-list-screen'
import { ProjectRuntime } from '@/modules/main/features/project-runtime/project-runtime'
import {
  addProject,
  chooseProjectDirectory,
  createProject,
  getBranding,
  getCreateProjectDefaults,
  getThumbnail,
  listProjects,
  listTemplates,
  notifyWindowScreen,
  onProjectCreateSubmitted,
  onWindowNavigateBack,
  onWindowOpenProject,
  openCreateProjectDialog,
  openEditProjectDialog,
  removeProject,
  showProjectCreateDialog,
  updateProject,
} from '@/shared/api'
import { ProjectEditDialog } from '@/shared/components/project-edit-dialog'
import type { Project, ProjectPatch } from '@/shared/types'

const DEFAULT_APP_NAME = 'Dimina DevTools'

export default function Main() {
  const [page, setPage] = useState('list')
  const [currentProject, setCurrentProject] = useState<Project | null>(null)
  const [projectList, setProjectList] = useState<Project[]>([])
  const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({})
  const [editingProject, setEditingProject] = useState<Project | null>(null)
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

  // Report our top-level screen to main so its window-close decision knows
  // whether to return to the project list or quit. Fires on entry (including a
  // failed open, which parks on the project screen) and on every change.
  useEffect(() => {
    notifyWindowScreen(page === 'project' ? 'project' : 'list')
  }, [page])

  useEffect(() => {
    const off = onWindowNavigateBack(() => {
      document.title = appName
      setPage('list')
      setCurrentProject(null)
      listProjects().then(setProjectList)
    })
    return off
  }, [appName])

  // Main-pushed open (MCP project_open): same path as a user click — mounting
  // ProjectRuntime (keyed by path) is what compiles and attaches the simulator.
  useEffect(() => {
    return onWindowOpenProject((p) => {
      setCurrentProject({ name: p.name, path: p.path })
      setPage('project')
    })
  }, [])

  // The overlay panel already hides itself (main-side) before relaying the
  // submission — see project-create.ts's Submit handler — so this only needs
  // to run the existing scaffold flow, not manage any open/closed state.
  useEffect(() => {
    return onProjectCreateSubmitted(handleCreateSubmit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    // First try the host-supplied dialog (downstream host/etc.). It can return:
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
    // in parallel, then ask main to show the overlay-panel dialog.
    const [tplsResult, defaultsResult] = await Promise.allSettled([
      listTemplates(),
      getCreateProjectDefaults(),
    ])
    showProjectCreateDialog({
      templates: tplsResult.status === 'fulfilled' ? tplsResult.value : [],
      defaultBaseDir: defaultsResult.status === 'fulfilled' ? defaultsResult.value.baseDir : '',
    })
  }

  async function handleCreateSubmit(input: {
    name: string
    path: string
    templateId: string
  }) {
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

  // First try the host-supplied dialog. `reply === null` means no hook is
  // configured, so fall back to the built-in dialog. A configured hook
  // always resolves `{ result }`, even when the user cancelled it
  // (`result: null`) — that case must NOT fall through to the built-in
  // dialog, unlike the create flow's collapsed-to-null wire shape.
  async function handleEdit(p: Project) {
    let reply: Awaited<ReturnType<typeof openEditProjectDialog>>
    try {
      reply = await openEditProjectDialog(p.path)
    } catch {
      reply = null
    }
    if (!reply) {
      setEditingProject(p)
      return
    }
    const result = reply.result
    if (!result) return
    if ('updated' in result) {
      await loadProjects()
      return
    }
    try {
      await updateProject(p.path, result)
    } catch (err) {
      console.warn('[projects] failed to update project', err)
      return
    }
    await loadProjects()
  }

  async function handleEditSubmit(patch: ProjectPatch) {
    const target = editingProject
    if (!target) return
    try {
      await updateProject(target.path, patch)
    } catch (err) {
      // Keep the dialog open with the user's input so a rejected edit (empty
      // name, record gone) can be corrected instead of silently discarded.
      console.warn('[projects] failed to update project', err)
      return
    }
    setEditingProject(null)
    await loadProjects()
  }

  function handleOpen(p: Project) {
    setCurrentProject(p)
    setPage('project')
  }

  if (page === 'list') {
    return (
      <>
        <ProjectListScreen
          projects={projectList}
          onAdd={handleAdd}
          onCreate={handleCreate}
          onOpen={handleOpen}
          onEdit={handleEdit}
          onRemove={handleRemove}
          thumbnails={thumbnails}
        />
        <ProjectEditDialog
          open={editingProject !== null}
          project={editingProject}
          onSubmit={handleEditSubmit}
          onCancel={() => setEditingProject(null)}
        />
      </>
    )
  }

  return (
    <ProjectRuntime key={currentProject?.path} project={currentProject!} />
  )
}
