/**
 * Resolving which page a service→container message acts on.
 *
 * The service names the page it is running for (`msg.body.bridgeId`).
 * A message that names nothing is app-scoped and is handled against the session's default page.
 * A message that names a page which is no longer in the session is a different thing entirely: the page really is gone, and silently substituting another page would let its call act on — and report success for — someone else's page. `onUnload` reaches main after the page's PAGE_CLOSE, so this is a routine ordering, not an exotic one.
 *
 * The default page is still handed back for the stale case so app-scoped traffic keeps working; `staleBridgeId` tells the caller the page identity was substituted, and page-scoped APIs refuse to run on the substitute.
 */

export interface ContainerPageRouting<TPage> {
  /** The page to handle the message against. */
  page: TPage
  /** The page the message named, when that page is already gone; else null. */
  staleBridgeId: string | null
}

export function routeContainerPage<TPage>(
  pages: ReadonlyMap<string, TPage>,
  namedBridgeId: string | undefined,
  fallback: TPage,
): ContainerPageRouting<TPage> {
  if (!namedBridgeId) return { page: fallback, staleBridgeId: null }
  const page = pages.get(namedBridgeId)
  if (page) return { page, staleBridgeId: null }
  return { page: fallback, staleBridgeId: namedBridgeId }
}

/** No currently supported API is scoped to a stale page identity. */
export function stalePageApiErrMsg(_name: string): string | null {
  return null
}
