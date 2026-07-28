/**
 * Canonical server-side path for the "新建项目" flow.
 *
 * `createProject(input, ctx)`:
 *  1. validates `input.name` (non-empty after trim) and `input.path` (does
 *     not exist OR exists but is an empty directory).
 *  2. resolves `input.templateId` (default 'blank') against `ctx.templates`.
 *  3. copies the template `source` directory into `input.path`, or invokes
 *     `template.generate(input.path, { name })` for programmatic templates.
 *  4. rewrites `<input.path>/project.config.json`'s `projectname` to
 *     `input.name`.
 *  5. registers the project with `ctx.projectsProvider.addProject(input.path)`
 *     and returns the resulting Project.
 */
import fs from 'node:fs'
import path from 'node:path'
import type {
  CreateProjectInput,
  Project,
  ProjectTemplate,
  ProjectsProvider,
} from './types.js'

export interface CreateProjectCtx {
  templates: ProjectTemplate[]
  projectsProvider: ProjectsProvider
}

const DEFAULT_TEMPLATE_ID = 'blank'

/** Non-empty-after-trim `input.name`, or throws. */
function resolveName(rawName: string | undefined): string {
  const name = (rawName ?? '').trim()
  if (name.length === 0) {
    throw new Error('Project name cannot be empty')
  }
  return name
}

/** `input.path` does-not-exist OR exists+empty, or throws. */
function validateTargetPath(target: unknown): asserts target is string {
  if (!target || typeof target !== 'string') {
    throw new Error('Project path is required')
  }
  if (!fs.existsSync(target)) return
  const stat = fs.statSync(target)
  if (!stat.isDirectory()) {
    throw new Error(`Project path exists and is not a directory: ${target}`)
  }
  const entries = fs.readdirSync(target)
  if (entries.length > 0) {
    throw new Error(
      `Project path is not empty (refusing to overwrite): ${target}`,
    )
  }
}

/** Look up `templateId` (default 'blank') and confirm it can materialise a project. */
function resolveTemplate(
  templates: ProjectTemplate[],
  templateId: string | undefined,
): ProjectTemplate {
  const id = templateId ?? DEFAULT_TEMPLATE_ID
  const template = templates.find((t) => t.id === id)
  if (!template) {
    throw new Error(`Template not found: ${id}`)
  }
  if (!template.source && !template.generate) {
    throw new Error(
      `Template '${id}' has neither a source directory nor a generate function`,
    )
  }
  return template
}

/** Ensure `target` exists, then copy the template's `source` tree or run its `generate`. */
async function materializeTemplate(
  target: string,
  template: ProjectTemplate,
  name: string,
): Promise<void> {
  fs.mkdirSync(target, { recursive: true })
  if (template.generate) {
    await template.generate(target, { name })
    return
  }
  if (!template.source) return
  if (!fs.existsSync(template.source.path)) {
    throw new Error(
      `Template source missing on disk: ${template.source.path}`,
    )
  }
  // `recursive: true` makes cp mirror the entire tree (files, subdirs,
  // symlinks). `force: true` mirrors over an empty target. `fs.promises.cp`
  // (not the sync `fs.cpSync`) deliberately: cpSync's no-filter directory
  // walk takes Node's native `cpSyncCopyDir` fast path, whose internal
  // filesystem calls can `abort()` the whole process on certain errors
  // (long/restricted/non-ASCII paths — nodejs/node#63970) instead of
  // throwing a catchable JS exception. The async `cp` walks in pure JS and
  // turns the same failures into a normal rejection this function already
  // propagates to its IPC-boundary try/catch.
  await fs.promises.cp(template.source.path, target, {
    recursive: true,
    force: true,
  })
}

/**
 * Rewrite `<target>/project.config.json`'s `projectname` (best-effort: create
 * the file if the template didn't ship one — gives the user a working
 * starting point even for tiny generators).
 */
function writeProjectConfig(target: string, name: string): void {
  const cfgPath = path.join(target, 'project.config.json')
  let cfg: Record<string, unknown> = {}
  if (fs.existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Record<
        string,
        unknown
      >
    } catch {
      cfg = {}
    }
  }
  cfg.projectname = name
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
}

export async function createProject(
  input: CreateProjectInput,
  ctx: CreateProjectCtx,
): Promise<Project> {
  const name = resolveName(input.name)

  const target = input.path
  validateTargetPath(target)

  const template = resolveTemplate(ctx.templates, input.templateId)

  await materializeTemplate(target, template, name)
  writeProjectConfig(target, name)

  // register with provider — this is what makes the new project appear
  // in the list immediately after the dialog closes.
  const created = await ctx.projectsProvider.addProject(target)
  return created
}
