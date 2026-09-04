import { afterEach, describe, expect, it, vi } from 'vitest'

const electronStubs = vi.hoisted(() => {
  const makeProtocolStub = () => {
    const installed = new Map<string, (request: { url: string }) => unknown>()
    return {
      installed,
      handle: vi.fn((scheme: string, fn: (request: { url: string }) => unknown) => {
        installed.set(scheme, fn)
      }),
      unhandle: vi.fn((scheme: string) => {
        installed.delete(scheme)
      }),
    }
  }
  const protocolStub = makeProtocolStub()
  const sessions = new Map<string, { protocol: ReturnType<typeof makeProtocolStub> }>()
  const fromPartition = (partition: string) => {
    let sess = sessions.get(partition)
    if (!sess) {
      sess = { protocol: makeProtocolStub() }
      sessions.set(partition, sess)
    }
    return sess
  }
  return { protocolStub, sessions, fromPartition }
})

vi.mock('electron', () => ({
  protocol: electronStubs.protocolStub,
  session: { fromPartition: electronStubs.fromPartition },
  default: {},
}))

import {
  SHARED_MINIAPP_PARTITION,
  __resetMiniappSessionConfigForTests,
  configureMiniappSession,
} from '../services/views/miniapp-partition.js'
import { addMuxedDmbResourceHandler } from './bridge-router-protocol-mux.js'

const SCHEME = 'dmb-resource'
const PROJECT_PARTITION = 'persist:miniapp-project-a'

const disposers: Array<() => void> = []

/** A router that owns exactly the named bridgeIds and reports itself by label. */
function addRouter(label: string, ownedBridgeIds: string[]) {
  const served: string[] = []
  const dispose = addMuxedDmbResourceHandler({
    claims: (requestUrl) => ownedBridgeIds.includes(new URL(requestUrl).hostname),
    handle: async (request) => {
      served.push(new URL(request.url).hostname)
      return new Response(label)
    },
  })
  disposers.push(dispose)
  return { label, served, dispose }
}

function liveHandler(registrar = electronStubs.protocolStub) {
  const handler = registrar.installed.get(SCHEME)
  expect(handler).toBeTypeOf('function')
  return handler as (request: { url: string }) => Promise<Response>
}

async function request(bridgeId: string, registrar = electronStubs.protocolStub): Promise<string> {
  const response = await liveHandler(registrar)({ url: `dmb-resource://${bridgeId}/app/main/x.js` })
  return response.text()
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  electronStubs.protocolStub.handle.mockClear()
  electronStubs.protocolStub.unhandle.mockClear()
  electronStubs.protocolStub.installed.clear()
  electronStubs.sessions.clear()
  __resetMiniappSessionConfigForTests()
})

describe('addMuxedDmbResourceHandler', () => {
  it('installs the scheme once for any number of routers', () => {
    addRouter('A', ['bridge-a'])
    addRouter('B', ['bridge-b'])

    expect(electronStubs.protocolStub.handle).toHaveBeenCalledTimes(1)
    expect(electronStubs.sessions.get(SHARED_MINIAPP_PARTITION)!.protocol.handle)
      .toHaveBeenCalledTimes(1)
  })

  it('serves each bridgeId from the router that owns it', async () => {
    const a = addRouter('A', ['bridge-a'])
    const b = addRouter('B', ['bridge-b'])

    // The FIRST-registered router must still get its own bridgeId once a newer
    // router exists — that is the cross-window mix-up this mux prevents.
    await expect(request('bridge-a')).resolves.toBe('A')
    await expect(request('bridge-b')).resolves.toBe('B')
    expect(a.served).toEqual(['bridge-a'])
    expect(b.served).toEqual(['bridge-b'])
  })

  it('hands an unowned bridgeId to the newest router so it answers as before', async () => {
    addRouter('A', ['bridge-a'])
    addRouter('B', ['bridge-b'])

    await expect(request('bridge-gone')).resolves.toBe('B')
  })

  it('serves the shared and per-project partitions with the same dispatch', async () => {
    addRouter('A', ['bridge-a'])
    addRouter('B', ['bridge-b'])
    configureMiniappSession(PROJECT_PARTITION)

    const shared = electronStubs.sessions.get(SHARED_MINIAPP_PARTITION)!
    const project = electronStubs.sessions.get(PROJECT_PARTITION)!
    await expect(request('bridge-a', shared.protocol)).resolves.toBe('A')
    await expect(request('bridge-a', project.protocol)).resolves.toBe('A')
    await expect(request('bridge-b', project.protocol)).resolves.toBe('B')
  })

  it('keeps the surviving router serving after another router is disposed', async () => {
    const a = addRouter('A', ['bridge-a'])
    const b = addRouter('B', ['bridge-b'])
    configureMiniappSession(PROJECT_PARTITION)

    b.dispose()

    expect(electronStubs.protocolStub.installed.has(SCHEME)).toBe(true)
    await expect(request('bridge-a')).resolves.toBe('A')
    const project = electronStubs.sessions.get(PROJECT_PARTITION)!
    await expect(request('bridge-a', project.protocol)).resolves.toBe('A')
    expect(a.served).toEqual(['bridge-a', 'bridge-a'])
  })

  it('unhandles every registrar only when the last router is disposed', () => {
    const a = addRouter('A', ['bridge-a'])
    const b = addRouter('B', ['bridge-b'])
    configureMiniappSession(PROJECT_PARTITION)
    const shared = electronStubs.sessions.get(SHARED_MINIAPP_PARTITION)!
    const project = electronStubs.sessions.get(PROJECT_PARTITION)!

    b.dispose()
    expect(shared.protocol.installed.has(SCHEME)).toBe(true)
    expect(project.protocol.installed.has(SCHEME)).toBe(true)

    a.dispose()
    expect(electronStubs.protocolStub.installed.has(SCHEME)).toBe(false)
    expect(shared.protocol.installed.has(SCHEME)).toBe(false)
    expect(project.protocol.installed.has(SCHEME)).toBe(false)
  })

  it('reinstalls after the last router leaves and a new one arrives', async () => {
    addRouter('A', ['bridge-a']).dispose()
    addRouter('C', ['bridge-c'])

    await expect(request('bridge-c')).resolves.toBe('C')
  })
})
