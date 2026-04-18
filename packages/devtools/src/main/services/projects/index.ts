// Thin re-export over project-repository so the `./projects` package export
// keeps working. The filesystem-level helpers live in project-repository.ts;
// higher-level coordination (session + renderer notifications) lives in
// ../workspace/workspace-service.ts.
export * from './project-repository.js'
