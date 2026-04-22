// Default preload script for the simulator <webview>.
// Composes all built-in instrumentation. For custom preloads, import individual
// functions from '@dimina-kit/devtools/preload' and assemble your own.
//
// This file is bundled into a single JS file via build:preload (esbuild)
// because webview sandbox cannot resolve require() for separate modules.
import { installSimulatorBridge } from '../runtime/bridge.js'
import { installConsoleInstrumentation } from '../instrumentation/console.js'
import { installAppDataInstrumentation } from '../instrumentation/app-data.js'
import { installWxmlInstrumentation } from '../instrumentation/wxml.js'
import { setupApiCompatHook } from '../shared/api-compat.js'

// Note: storage panel data is sourced from the main process via the CDP
// DOMStorage domain (src/main/services/simulator-storage). No preload-side
// localStorage hook is required.

setupApiCompatHook()
installSimulatorBridge()
installConsoleInstrumentation()
installAppDataInstrumentation()
installWxmlInstrumentation()
