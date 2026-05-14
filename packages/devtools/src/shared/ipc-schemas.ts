/**
 * Centralised zod schemas for IPC handler argument validation.
 *
 * Only the highest-risk handlers are validated here. Each schema is shaped as a
 * `z.tuple([...])` matching the `(event, ...args)` argument list that an
 * `ipcMain.handle` callback receives (event is stripped before validation).
 */

import { z } from 'zod'

/**
 * Conservative absolute-path matcher.
 * Accepts:
 *   - POSIX absolute paths (start with `/`)
 *   - Windows absolute paths (e.g. `C:\foo`, `C:/foo`)
 * Rejects empty strings, relative paths and other shapes.
 */
const AbsolutePath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      p.startsWith('/') || /^[a-zA-Z]:\\/.test(p) || /^[a-zA-Z]:\//.test(p),
    'must be an absolute path',
  )

/** panel:eval — single JS expression string. Cap at 50_000 chars to avoid DoS. */
export const PanelEvalSchema = z.tuple([z.string().min(1).max(50_000)])

/** projects:add — absolute directory path. */
export const ProjectsAddSchema = z.tuple([AbsolutePath])

/** project:open — absolute project path. */
export const ProjectOpenSchema = z.tuple([AbsolutePath])

/**
 * Shared shape for CompileConfig payloads (used by saveCompileConfig,
 * settings:configChanged, and popover:relaunch). Permissive on the outer
 * object so we stay forward-compatible with new fields; the known top-level
 * keys are validated to catch wrong types early.
 */
const CompileConfigShape = z.looseObject({
  startPage: z.string().optional(),
  scene: z.number().optional(),
  queryParams: z
    .array(z.looseObject({ key: z.string(), value: z.string() }))
    .optional(),
})

/**
 * project:saveCompileConfig — absolute project path + CompileConfig.
 */
export const ProjectSaveCompileConfigSchema = z.tuple([
  AbsolutePath,
  CompileConfigShape,
])

/** popover:show — must be an object (not undefined/null/string). */
export const PopoverShowSchema = z.tuple([z.looseObject({})])

/**
 * Reasonable simulator width range. Window width is clamped UI-side, but
 * we still reject obvious garbage (negative, zero, absurdly large).
 */
const SimWidth = z.number().int().min(100).max(2000)

/** simulator:attach — webContents id (positive int) + simulator width. */
export const SimulatorAttachSchema = z.tuple([
  z.number().int().positive(),
  SimWidth,
])

/** simulator:resize — simulator width. */
export const SimulatorResizeSchema = z.tuple([SimWidth])

/** simulator:setVisible — visible flag + simulator width. */
export const SimulatorSetVisibleSchema = z.tuple([z.boolean(), SimWidth])

/** project:getPages — absolute project path. */
export const ProjectGetPagesSchema = z.tuple([AbsolutePath])

/** project:getCompileConfig — absolute project path. */
export const ProjectGetCompileConfigSchema = z.tuple([AbsolutePath])

/** projects:remove — absolute project directory path. */
export const ProjectsRemoveSchema = z.tuple([AbsolutePath])

/**
 * workbenchSettings:save — full WorkbenchSettings object.
 *
 * `saveWorkbenchSettings()` overwrites the whole settings file (no merge),
 * so a partial payload would silently reset whatever fields it omits to
 * defaults. Require every top-level slice so the renderer can't accidentally
 * (or maliciously) wipe configuration by sending `{}`.
 */
export const WorkbenchSettingsSaveSchema = z.tuple([
  z.looseObject({
    cdp: z.looseObject({
      enabled: z.boolean(),
      port: z.number().int().min(0).max(65535),
    }),
    mcp: z.looseObject({
      enabled: z.boolean(),
      port: z.number().int().min(0).max(65535),
    }),
    theme: z.enum(['system', 'light', 'dark']),
  }),
])

/** workbenchSettings:setTheme — fixed enum of supported theme sources. */
export const WorkbenchSettingsSetThemeSchema = z.tuple([
  z.enum(['system', 'light', 'dark']),
])

/** workbenchSettings:setVisible — boolean. */
export const WorkbenchSettingsSetVisibleSchema = z.tuple([z.boolean()])

/** settings:setVisible — boolean. */
export const SettingsSetVisibleSchema = z.tuple([z.boolean()])

/** settings:configChanged — full CompileConfig object (see shared/types.ts). */
export const SettingsConfigChangedSchema = z.tuple([CompileConfigShape])

/** popover:relaunch — full CompileConfig object pushed back to main on relaunch. */
export const PopoverRelaunchSchema = z.tuple([CompileConfigShape])

/**
 * settings:projectSettingsChanged — Partial<ProjectSettings>.
 *
 * ProjectSettings currently has a single boolean field
 * (`uploadWithSourceMap`); validated permissively to remain forward-
 * compatible while still rejecting non-object payloads.
 */
export const SettingsProjectSettingsChangedSchema = z.tuple([
  z.looseObject({
    uploadWithSourceMap: z.boolean().optional(),
  }),
])

/** panel:select — single panel id string. */
export const PanelSelectSchema = z.tuple([z.string().min(1).max(200)])
