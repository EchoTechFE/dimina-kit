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

/**
 * simulator:attach-native (native-host only) — the simulator URL to load into
 * the top-level WebContentsView + simulator width. The URL is the dev-server
 * `http://localhost:<port>/simulator.html?…` the renderer would otherwise put
 * on the `<webview src>`; we validate it's an http(s) URL to keep the WCV off
 * arbitrary origins (will-navigate hardening re-checks at navigation time).
 */
export const SimulatorAttachNativeSchema = z.tuple([
  z.string().url().refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
    message: 'simulator URL must be http(s)',
  }),
  SimWidth,
])

/**
 * simulator:soft-reload (native-host only) — the rebuilt simulator URL to
 * soft-reload the live shell at. Same http(s)-only constraint as AttachNative
 * (the URL becomes the new app session's route inside the existing WCV).
 */
export const SimulatorSoftReloadSchema = z.tuple([
  z.string().url().refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
    message: 'simulator URL must be http(s)',
  }),
])

/**
 * simulator:set-device-info (native-host only) — the selected device's logical
 * metrics, mapped by main into the service-host window's HostEnvSnapshot. Sizes
 * are bounded positive ints (logical device px); strings are bounded to keep the
 * payload small. Matches `NativeDeviceInfo` in ipc-channels.ts.
 */
export const SimulatorSetDeviceInfoSchema = z.tuple([
  z.object({
    brand: z.string().max(64),
    model: z.string().max(64),
    system: z.string().max(64),
    platform: z.string().max(32),
    pixelRatio: z.number().finite().positive(),
    screenWidth: z.number().int().min(100).max(4000),
    screenHeight: z.number().int().min(100).max(4000),
    statusBarHeight: z.number().finite().min(0).max(400),
    notchType: z.enum(['none', 'notch', 'dynamic-island']),
    safeAreaInsets: z.object({
      top: z.number().finite().min(0).max(400),
      right: z.number().finite().min(0).max(400),
      bottom: z.number().finite().min(0).max(400),
      left: z.number().finite().min(0).max(400),
    }),
  }),
])

// Non-negative bounded integer used by the reverse height-advertise payload.
const NonNegInt = z.number().int().min(0).max(100_000)

/**
 * view:placement-snapshot — the window-level desired-placement table driving
 * the reconciler. `generation`/`epoch` are non-negative monotonic counters.
 * Each view carries an opaque string id, a discriminated placement (visible +
 * bounds, or hidden — bounds are plain finite numbers: x/y may be negative when
 * scrolled off-screen, w/h may be 0 for a visible-but-empty view), a z-order
 * layer, and optional host extras (the simulator's zoom).
 */
const FiniteNum = z.number().finite()
const PlacementSchema = z.union([
  z.object({
    visible: z.literal(true),
    bounds: z.object({
      x: FiniteNum,
      y: FiniteNum,
      width: FiniteNum,
      height: FiniteNum,
    }),
  }),
  z.object({ visible: z.literal(false) }),
])
export const PlacementSnapshotSchema = z.tuple([
  z.object({
    generation: z.number().int().min(0),
    epoch: z.number().int().min(0),
    views: z.array(
      z.object({
        viewId: z.string().min(1).max(64),
        placement: PlacementSchema,
        layer: z.number().int(),
        extra: z
          .object({ zoom: z.number().finite().positive().optional() })
          .optional(),
      }),
    ).max(64),
  }),
])

/**
 * host-toolbar reverse size-advertiser payload — the toolbar WCV renderer
 * advertises its intrinsic content height on the block axis. Mirrors
 * `@dimina-kit/view-anchor`'s `AdvertisedSize`.
 */
export const HostToolbarAdvertiseHeightSchema = z.tuple([
  z.object({
    axis: z.literal('block'),
    extent: NonNegInt,
  }),
])

/**
 * simulator:custom-apis:invoke — API name + arbitrary JSON-serialisable params.
 *
 * Params shape is owned by the downstream handler, so we only enforce that the
 * name is a non-empty bounded string (cheap DoS guard) and accept any payload.
 */
export const SimulatorCustomApiInvokeSchema = z.tuple([
  z.string().min(1).max(256),
  z.unknown(),
])

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
    compile: z.looseObject({
      watch: z.boolean(),
    }),
    theme: z.enum(['system', 'light', 'dark']),
    lastCreateBaseDir: z.union([z.string(), z.null()]),
  }),
])

/** workbenchSettings:setTheme — fixed enum of supported theme sources. */
export const WorkbenchSettingsSetThemeSchema = z.tuple([
  z.enum(['system', 'light', 'dark']),
])

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

/** project:captureThumbnail — absolute project path. */
export const ProjectCaptureThumbnailSchema = z.tuple([AbsolutePath])

/** project:getThumbnail — absolute project path. */
export const ProjectGetThumbnailSchema = z.tuple([AbsolutePath])

/** project:getLaunchConfigs — absolute project path. */
export const ProjectGetLaunchConfigsSchema = z.tuple([AbsolutePath])

/**
 * project:saveLaunchConfigs — absolute path + array of launch configs.
 * Each config extends CompileConfig with `id` and `name`.
 */
const LaunchConfigShape = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  startPage: z.string().optional(),
  scene: z.number().optional(),
  queryParams: z
    .array(z.looseObject({ key: z.string(), value: z.string() }))
    .optional(),
})
export const ProjectSaveLaunchConfigsSchema = z.tuple([
  AbsolutePath,
  z.array(LaunchConfigShape),
])

/** project:getActiveLaunchConfigId — absolute project path. */
export const ProjectGetActiveLaunchConfigIdSchema = z.tuple([AbsolutePath])

/** project:saveActiveLaunchConfigId — absolute path + id (string or null). */
export const ProjectSaveActiveLaunchConfigIdSchema = z.tuple([
  AbsolutePath,
  z.union([z.string(), z.null()]),
])

/** popover:switchLaunchConfig — id (string) or null for normal mode. */
export const PopoverSwitchLaunchConfigSchema = z.tuple([
  z.union([z.string(), z.null()]),
])

/** popover:updateLaunchConfigs — full launch config array. */
export const PopoverUpdateLaunchConfigsSchema = z.tuple([
  z.array(LaunchConfigShape),
])
