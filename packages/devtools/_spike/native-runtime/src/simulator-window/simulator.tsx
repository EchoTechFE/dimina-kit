import React, { useCallback, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CHANNELS } from '../shared/channels'

declare global {
  interface Window {
    require?: (name: string) => { ipcRenderer: Electron.IpcRenderer }
  }
}

const electronRequire = window.require
if (!electronRequire) {
  throw new Error('[simulator] window.require is unavailable; BrowserWindow must enable nodeIntegration for this PoC')
}

const { ipcRenderer } = electronRequire('electron')
const query = new URLSearchParams(window.location.search)
const renderSrc = query.get('renderSrc')
const renderPreload = query.get('renderPreload')

if (!renderSrc || !renderPreload) {
  throw new Error('[simulator] missing renderSrc/renderPreload query params')
}

function withRenderQuery(bridgeId: string, pagePath: string) {
  const url = new URL(renderSrc!)
  url.searchParams.set('bridgeId', bridgeId)
  url.searchParams.set('pagePath', pagePath)
  return url.toString()
}

function App() {
  const [bridgeId, setBridgeId] = useState<string | null>(null)
  const [pagePath, setPagePath] = useState('pages/index/index')
  const [domReady, setDomReady] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const spawn = useCallback(async () => {
    setDomReady(false)
    const result = await ipcRenderer.invoke(CHANNELS.SPAWN, {
      appId: 'hello-world',
      pagePath: 'pages/index/index',
      scene: 1001,
      query: {},
    })
    setBridgeId(result.bridgeId)
    setPagePath(result.pagePath)
    setReloadKey(key => key + 1)
  }, [])

  React.useEffect(() => {
    spawn().catch(error => {
      console.error('[simulator] spawn failed', error)
    })

    const onDomReady = (_event: unknown, payload: { bridgeId: string }) => {
      console.log('[simulator] dom ready', payload)
      setDomReady(true)
    }
    ipcRenderer.on('simulator:dom-ready', onDomReady)
    return () => {
      ipcRenderer.removeListener('simulator:dom-ready', onDomReady)
    }
  }, [spawn])

  const webviewSrc = useMemo(() => {
    return bridgeId ? withRenderQuery(bridgeId, pagePath) : ''
  }, [bridgeId, pagePath])

  return (
    <main className="shell">
      <header className="toolbar">
        <div>
          <strong>Native Runtime PoC</strong>
          <span>{bridgeId || 'spawning...'}</span>
        </div>
        <button type="button" onClick={spawn}>Reload</button>
      </header>
      <section className="device">
        <div className="status">{domReady ? 'DOM ready' : 'Loading'}</div>
        {bridgeId ? (
          <webview
            key={`${bridgeId}-${reloadKey}`}
            className="page-frame"
            src={webviewSrc}
            preload={`file://${renderPreload}`}
            partition="persist:dimina-native-runtime-spike"
            allowpopups="true"
          />
        ) : null}
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)

const style = document.createElement('style')
style.textContent = `
  * { box-sizing: border-box; }
  html, body, #root { height: 100%; margin: 0; }
  body {
    background: #f4f6f8;
    color: #17202a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .shell {
    min-height: 100%;
    display: grid;
    grid-template-rows: auto 1fr;
  }
  .toolbar {
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    background: #ffffff;
    border-bottom: 1px solid #d8dee4;
  }
  .toolbar div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .toolbar span {
    color: #667085;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 520px;
  }
  .toolbar button {
    height: 32px;
    border: 1px solid #98a2b3;
    border-radius: 6px;
    background: #ffffff;
    padding: 0 12px;
    cursor: pointer;
  }
  .device {
    width: 390px;
    height: 844px;
    align-self: start;
    justify-self: center;
    margin: 24px;
    background: #ffffff;
    border: 1px solid #cfd8e3;
    overflow: hidden;
    display: grid;
    grid-template-rows: 28px 1fr;
  }
  .status {
    display: flex;
    align-items: center;
    padding: 0 10px;
    font-size: 12px;
    color: #475467;
    background: #f8fafc;
    border-bottom: 1px solid #e5e7eb;
  }
  .page-frame {
    width: 100%;
    height: 100%;
    border: 0;
  }
`
document.head.append(style)
