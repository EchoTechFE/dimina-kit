/**
 * Electron's `<webview>` is not one of React's intrinsic elements, and a
 * mini-app page IS a guest webview — the frame cannot render a page without it.
 *
 * Declared in both namespaces on purpose. The `react-jsx` transform looks the
 * element up in `React.JSX.IntrinsicElements` under @types/react 19, which
 * dropped the global `JSX` namespace; @types/react 18 still routes through the
 * global one. Only the module augmentation would leave a React 18 build without
 * the element, and only the global one would leave a React 19 build without it.
 */
import type { DetailedHTMLProps, HTMLAttributes, Ref } from 'react'

type WebviewIntrinsicProps = DetailedHTMLProps<
  HTMLAttributes<HTMLElement> & {
    src?: string
    preload?: string
    partition?: string
    allowpopups?: string
  },
  HTMLElement
> & { ref?: Ref<HTMLElement | null> }

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: WebviewIntrinsicProps
    }
  }
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: WebviewIntrinsicProps
    }
  }
}
