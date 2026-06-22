/**
 * Contract: `createProject(input, ctx)` is the canonical
 * server-side path for the "新建项目" flow. It must:
 *  - reject an empty/whitespace name, an existing-non-empty target path, an
 *    unknown templateId — with messages the renderer can display verbatim.
 *  - on the happy path: copy the template `source` directory into `path`,
 *    overwrite `project.config.json.projectname` with the user-supplied
 *    name, then register the project with `ctx.projectsProvider.addProject`
 *    and return the resulting Project.
 *
 * Bugs each test catches:
 *  - Missing name-validation lets the user scaffold a project with a blank
 *    name; downstream renderers show "undefined" or crash.
 *  - Missing path-collision check overwrites a user's existing project
 *    silently — data-loss bug.
 *  - Missing template lookup makes the service crash with a TypeError
 *    instead of a friendly "template not found" error.
 *  - Forgetting to call `provider.addProject` leaves a created-on-disk
 *    project absent from the list — user can't open what they just made.
 *  - Forgetting to rewrite projectname makes the new project show with the
 *    template's pre-baked name (e.g. "Blank") instead of the user's input.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

let createProject: typeof import('./create-project-service.js').createProject

beforeEach(async () => {
  vi.resetModules()
  ;({ createProject } = await import('./create-project-service.js'))
})

/** Make a unique tmp directory for each test so they don't trample each other. */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-create-test-'))
}

/** Write a minimal "blank-like" template fixture into a fresh dir. Returns absolute path. */
function makeFixtureTemplate(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-tpl-'))
  fs.writeFileSync(path.join(dir, 'app.json'), '{"pages":["pages/index/index"]}')
  fs.writeFileSync(path.join(dir, 'app.js'), 'App({})')
  fs.writeFileSync(
    path.join(dir, 'project.config.json'),
    JSON.stringify({ projectname: 'PLACEHOLDER', appid: 'wxplaceholder' }),
  )
  fs.mkdirSync(path.join(dir, 'pages', 'index'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pages', 'index', 'index.js'), 'Page({})')
  return dir
}

function makeCtx(injected: Partial<{
  templates: import('./types.js').ProjectTemplate[]
  provider: import('./types.js').ProjectsProvider
}> = {}) {
  const addProject = vi.fn((p: string) => ({
    name: 'fake-from-provider',
    path: p,
    lastOpened: null,
  }))
  const provider = injected.provider ?? ({
    listProjects: () => [],
    addProject,
    removeProject: vi.fn(),
    validateProjectDir: vi.fn(() => null),
  } as import('./types.js').ProjectsProvider)
  return {
    templates:
      injected.templates ??
      ([{ id: 'blank', name: 'Blank' }] as import('./types.js').ProjectTemplate[]),
    projectsProvider: provider,
    addProjectSpy: addProject,
  }
}

describe('createProject — validation', () => {
  it('rejects empty name', async () => {
    const target = path.join(makeTmpDir(), 'sub') // does not exist yet
    const ctx = makeCtx()
    await expect(
      createProject({ name: '', path: target, templateId: 'blank' }, ctx),
    ).rejects.toThrow(/name/i)
  })

  it('rejects whitespace-only name', async () => {
    const target = path.join(makeTmpDir(), 'sub')
    const ctx = makeCtx()
    await expect(
      createProject({ name: '   ', path: target, templateId: 'blank' }, ctx),
    ).rejects.toThrow(/name/i)
  })

  it('rejects an unknown templateId with a message that names the id', async () => {
    const target = path.join(makeTmpDir(), 'sub')
    const ctx = makeCtx()
    await expect(
      createProject(
        { name: 'My App', path: target, templateId: 'no-such-template' },
        ctx,
      ),
    ).rejects.toThrow(/no-such-template/)
  })

  it('rejects when the target path is an existing NON-empty directory (overwrite guard)', async () => {
    const target = makeTmpDir()
    fs.writeFileSync(path.join(target, 'existing.txt'), 'hi')
    const fixture = makeFixtureTemplate()
    const ctx = makeCtx({
      templates: [
        {
          id: 'blank',
          name: 'Blank',
          source: { type: 'directory', path: fixture },
        },
      ],
    })
    await expect(
      createProject({ name: 'My App', path: target, templateId: 'blank' }, ctx),
    ).rejects.toThrow(/not empty|already|exists/i)
  })

  it('accepts a non-existent target path (creates it)', async () => {
    const target = path.join(makeTmpDir(), 'new-sub')
    const fixture = makeFixtureTemplate()
    const ctx = makeCtx({
      templates: [
        {
          id: 'blank',
          name: 'Blank',
          source: { type: 'directory', path: fixture },
        },
      ],
    })
    const project = await createProject(
      { name: 'My App', path: target, templateId: 'blank' },
      ctx,
    )
    expect(project).toBeDefined()
    expect(fs.existsSync(path.join(target, 'app.json'))).toBe(true)
  })

  it('accepts an existing EMPTY directory as target (typical "user just made a folder" case)', async () => {
    const target = makeTmpDir() // exists, empty
    const fixture = makeFixtureTemplate()
    const ctx = makeCtx({
      templates: [
        {
          id: 'blank',
          name: 'Blank',
          source: { type: 'directory', path: fixture },
        },
      ],
    })
    const project = await createProject(
      { name: 'My App', path: target, templateId: 'blank' },
      ctx,
    )
    expect(project).toBeDefined()
    expect(fs.existsSync(path.join(target, 'app.json'))).toBe(true)
  })
})

describe('createProject — happy path', () => {
  it('copies the template source tree, including nested files', async () => {
    const target = path.join(makeTmpDir(), 'new')
    const fixture = makeFixtureTemplate()
    const ctx = makeCtx({
      templates: [
        {
          id: 'blank',
          name: 'Blank',
          source: { type: 'directory', path: fixture },
        },
      ],
    })
    await createProject(
      { name: 'My App', path: target, templateId: 'blank' },
      ctx,
    )
    expect(fs.existsSync(path.join(target, 'app.json'))).toBe(true)
    expect(fs.existsSync(path.join(target, 'pages', 'index', 'index.js'))).toBe(
      true,
    )
  })

  it("rewrites project.config.json projectname to the user-supplied input.name", async () => {
    const target = path.join(makeTmpDir(), 'new')
    const fixture = makeFixtureTemplate()
    const ctx = makeCtx({
      templates: [
        {
          id: 'blank',
          name: 'Blank',
          source: { type: 'directory', path: fixture },
        },
      ],
    })
    await createProject(
      { name: '我的小程序', path: target, templateId: 'blank' },
      ctx,
    )
    const cfg = JSON.parse(
      fs.readFileSync(path.join(target, 'project.config.json'), 'utf-8'),
    ) as { projectname?: string }
    expect(cfg.projectname).toBe('我的小程序')
  })

  it("calls ctx.projectsProvider.addProject(target) so the new project shows up in the list", async () => {
    const target = path.join(makeTmpDir(), 'new')
    const fixture = makeFixtureTemplate()
    const ctx = makeCtx({
      templates: [
        {
          id: 'blank',
          name: 'Blank',
          source: { type: 'directory', path: fixture },
        },
      ],
    })
    await createProject(
      { name: 'X', path: target, templateId: 'blank' },
      ctx,
    )
    expect(ctx.addProjectSpy).toHaveBeenCalledTimes(1)
    expect(ctx.addProjectSpy).toHaveBeenCalledWith(target)
  })

  it('defaults to templateId="blank" when input.templateId is omitted', async () => {
    const target = path.join(makeTmpDir(), 'new')
    const fixture = makeFixtureTemplate()
    const ctx = makeCtx({
      templates: [
        {
          id: 'blank',
          name: 'Blank',
          source: { type: 'directory', path: fixture },
        },
        {
          id: 'other',
          name: 'Other',
          // No source — would fail if chosen.
        },
      ],
    })
    const project = await createProject({ name: 'X', path: target }, ctx)
    expect(project).toBeDefined()
    expect(fs.existsSync(path.join(target, 'app.json'))).toBe(true)
  })

  it('invokes template.generate(target, { name }) when the template has no source', async () => {
    const target = path.join(makeTmpDir(), 'new')
    const generate = vi.fn(async (dest: string, _opts: { name: string }) => {
      fs.mkdirSync(dest, { recursive: true })
      fs.writeFileSync(path.join(dest, 'generated.txt'), 'ok')
      fs.writeFileSync(
        path.join(dest, 'project.config.json'),
        JSON.stringify({ projectname: 'PLACEHOLDER' }),
      )
    })
    const ctx = makeCtx({
      templates: [{ id: 'codegen', name: 'CodeGen', generate }],
    })
    await createProject(
      { name: 'CG', path: target, templateId: 'codegen' },
      ctx,
    )
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0]![0]).toBe(target)
    expect(generate.mock.calls[0]![1]).toEqual({ name: 'CG' })
    expect(fs.existsSync(path.join(target, 'generated.txt'))).toBe(true)
    // generate-based templates also get name rewritten in project.config.json.
    const cfg = JSON.parse(
      fs.readFileSync(path.join(target, 'project.config.json'), 'utf-8'),
    ) as { projectname?: string }
    expect(cfg.projectname).toBe('CG')
  })
})
