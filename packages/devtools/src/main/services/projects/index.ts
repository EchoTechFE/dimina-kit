// Thin re-export over project-repository so the `./projects` package export
// keeps working. The filesystem-level helpers live in project-repository.ts;
// higher-level coordination (session + renderer notifications) lives in
// ../workspace/workspace-service.ts.
//
// Phase 1 adds the extensibility surface: `types.ts` (ProjectsProvider,
// ProjectTemplate, CreateProjectInput) and `local-provider.ts` (the default
// implementation injected when the host omits `projectsProvider`).
export * from './project-repository.js'
export { createLocalProjectsProvider } from './local-provider.js'
export type {
  ProjectsProvider,
  ProjectTemplate,
  CreateProjectInput,
  BuiltinTemplatesMode,
} from './types.js'
export { DEFAULT_COMPILE_CONFIG } from './types.js'
export { resolveTemplates, sanitizeTemplates } from './templates.js'
export { BUILTIN_TEMPLATES } from './builtin-templates.js'
export { createProject } from './create-project-service.js'
export type { CreateProjectCtx } from './create-project-service.js'
