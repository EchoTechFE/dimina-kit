/// <reference types="vite/client" />
/// <reference types="@testing-library/jest-dom" />

interface Window {
  require: (module: 'electron') => {
    ipcRenderer: import('electron').IpcRenderer
  }
}

declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        src?: string
        preload?: string
        partition?: string
        allowpopups?: string
      },
      HTMLElement
    > & { ref?: React.Ref<HTMLElement | null> }
  }
}
