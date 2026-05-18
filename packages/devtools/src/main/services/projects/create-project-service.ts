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

export async function createProject(
  input: CreateProjectInput,
  ctx: CreateProjectCtx,
): Promise<Project> {
  // 1. name validation
  const name = (input.name ?? '').trim()
  if (name.length === 0) {
    throw new Error('Project name cannot be empty')
  }

  // 2. path validation: does-not-exist OR exists+empty.
  const target = input.path
  if (!target || typeof target !== 'string') {
    throw new Error('Project path is required')
  }
  if (fs.existsSync(target)) {
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

  // 3. template lookup (default 'blank')
  const templateId = input.templateId ?? DEFAULT_TEMPLATE_ID
  const template = ctx.templates.find((t) => t.id === templateId)
  if (!template) {
    throw new Error(`Template not found: ${templateId}`)
  }
  if (!template.source && !template.generate) {
    throw new Error(
      `Template '${templateId}' has neither a source directory nor a generate function`,
    )
  }

  // 4. materialise: ensure target exists, then copy or generate.
  fs.mkdirSync(target, { recursive: true })
  if (template.generate) {
    await template.generate(target, { name })
  } else if (template.source) {
    if (!fs.existsSync(template.source.path)) {
      throw new Error(
        `Template source missing on disk: ${template.source.path}`,
      )
    }
    // `recursive: true` makes cpSync mirror the entire tree (files,
    // subdirs, symlinks). `force: true` mirrors over an empty target.
    fs.cpSync(template.source.path, target, {
      recursive: true,
      force: true,
    })
  }

  // 5. rewrite project.config.json projectname (best-effort: create the file
  // if the template didn't ship one — gives the user a working starting
  // point even for tiny generators).
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

  // 6. register with provider — this is what makes the new project appear
  // in the list immediately after the dialog closes.
  const created = await ctx.projectsProvider.addProject(target)
  return created
}
