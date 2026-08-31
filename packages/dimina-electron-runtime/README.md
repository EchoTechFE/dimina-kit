# @dimina-kit/electron-runtime

> Run a [Dimina](https://github.com/didi/dimina) mini-app inside an Electron app
> you already have.

The host keeps ownership of Electron's `app`, `BrowserWindow`, layout, and
shutdown lifecycle. This package owns the rest: compilation-session wiring, the
mini-app bridge, and the `WebContentsView` the mini-app renders into.

## Install

```bash
pnpm add @dimina-kit/electron-runtime @dimina-kit/devkit
```

`electron` (`^43.2.0`) is a required peer dependency; `react` is optional.
`@dimina-kit/devkit` supplies the `openProject` compiler adapter used below —
substitute your own adapter if you compile mini-apps some other way.

## Quick start

```ts
import { app, BrowserWindow } from 'electron'
import {
  createElectronRuntime,
  registerElectronRuntimeSchemes,
} from '@dimina-kit/electron-runtime'
import { openProject } from '@dimina-kit/devkit'

registerElectronRuntimeSchemes()
await app.whenReady()
const window = new BrowserWindow()
const runtime = await createElectronRuntime({
  hostWindow: window,
  adapter: { openProject },
})
const session = await runtime.openProject({ projectPath: '/absolute/miniapp' })
window.contentView.addChildView(session.view)
session.setBounds({ x: 0, y: 0, width: 390, height: 844 })
await session.ready
```

Call `session.dispose()` before removing a project, and `runtime.dispose()` when
the host tears down the integration. One runtime may be active per Electron
process because its bridge uses process-global `ipcMain` channels.

## Process-global schemes

Electron allows `protocol.registerSchemesAsPrivileged()` to run only once and
only before the app is ready. `registerElectronRuntimeSchemes()` is a convenience
for hosts that do not register any other privileged schemes. If the host owns
that registration, merge the exported descriptors into its one call instead:

```ts
import { protocol } from 'electron'
import { ELECTRON_RUNTIME_SCHEMES } from '@dimina-kit/electron-runtime'

protocol.registerSchemesAsPrivileged([
  ...ELECTRON_RUNTIME_SCHEMES,
  { scheme: 'my-app', privileges: { standard: true, secure: true } },
])
```

## Bundling and assets

The package ships renderer, preload, and HTML assets under its `dist/`
directory. When the main-process bundler keeps `@dimina-kit/electron-runtime`
external, the runtime resolves that directory from the installed package.

When bundling the runtime code into the host's main bundle, copy the package's
complete `dist/` directory into the packaged application and pass its absolute
path explicitly:

```ts
const runtime = await createElectronRuntime({
  hostWindow: window,
  adapter: { openProject },
  assetsRoot: path.join(process.resourcesPath, 'dimina-electron-runtime'),
})
```

The `assetsRoot` directory must directly contain `simulator/`, `preload/`,
`render-host/`, `service-host/`, and `native-host/`. Copy the complete
directory rather than selecting individual files: the service and render host
HTML files load JavaScript and CSS from `native-host/`. Runtime creation
validates these files before installing process-global IPC handlers, so a
packaging error fails without leaving a partial integration behind.

## License

[MIT](../../LICENSE) © EchoTechFE
