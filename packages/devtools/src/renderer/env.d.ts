/// <reference types="vite/client" />
/// <reference types="@testing-library/jest-dom" />

interface Window {
  require: (module: 'electron') => {
    ipcRenderer: import('electron').IpcRenderer
  }
}
