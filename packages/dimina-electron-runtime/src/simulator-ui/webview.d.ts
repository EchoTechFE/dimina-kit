/**
 * Electron's `<webview>` is not one of React's intrinsic elements, and a
 * mini-app page IS a guest webview — the frame cannot render a page without it.
 * The declaration ships with this source so a consumer type-checking the
 * subpath export gets it too, the same way `css.d.ts` carries the stylesheet
 * module declaration.
 */
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
