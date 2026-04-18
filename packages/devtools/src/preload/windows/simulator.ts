// Default preload script for the simulator <webview>.
// Composes all built-in instrumentation. For custom preloads, import individual
// functions from '@dimina-kit/devtools/preload' and assemble your own.
//
// This file is bundled into a single JS file via build:preload (esbuild)
// because webview sandbox cannot resolve require() for separate modules.
import { installSimulatorBridge } from '../runtime/bridge.js'
import { installConsoleInstrumentation } from '../instrumentation/console.js'
import { installStorageInstrumentation } from '../instrumentation/storage.js'
import { installAppDataInstrumentation } from '../instrumentation/app-data.js'
import { installWxmlInstrumentation } from '../instrumentation/wxml.js'
import { setupApiCompatHook } from '../shared/api-compat.js'

setupApiCompatHook()
installSimulatorBridge()
installConsoleInstrumentation()
installStorageInstrumentation()
installAppDataInstrumentation()
installWxmlInstrumentation()
