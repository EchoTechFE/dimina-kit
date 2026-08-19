import { describe, expect, it } from 'vitest'
import { routeContainerPage, stalePageApiErrMsg } from './container-routing.js'

interface Page { bridgeId: string }

const root: Page = { bridgeId: 'root' }
const child: Page = { bridgeId: 'child' }
const pages = new Map<string, Page>([['root', root], ['child', child]])

describe('routeContainerPage', () => {
  it('handles a message that names no page against the default page', () => {
    expect(routeContainerPage(pages, undefined, root)).toEqual({ page: root, staleBridgeId: null })
  })

  it('routes a message to the page it names', () => {
    expect(routeContainerPage(pages, 'child', root)).toEqual({ page: child, staleBridgeId: null })
  })

  it('reports the named page as stale once it left the session', () => {
    const closed = new Map<string, Page>([['root', root]])
    expect(routeContainerPage(closed, 'child', root)).toEqual({ page: root, staleBridgeId: 'child' })
  })
})

describe('stalePageApiErrMsg', () => {
  it('lets app-scoped APIs run against the default page', () => {
    expect(stalePageApiErrMsg('request')).toBeNull()
    expect(stalePageApiErrMsg('showToast')).toBeNull()
  })
})
