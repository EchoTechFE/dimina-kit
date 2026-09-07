import type { NativeRequestResult, NativeRequestService } from "./types.js";
import { createNativeRequestTransport } from "./transport.js";
import { createRequestTracer, type NativeRequestTracer } from "./trace.js";

interface RequestEntry {
  controller: AbortController;
  settled: boolean;
}

export function createNativeRequestService(): NativeRequestService {
  const transport = createNativeRequestTransport();
  const owners = new Map<string, Map<string, RequestEntry>>();
  let tracer: NativeRequestTracer | undefined;
  let disposed = false;

  const owner = (ownerId: string): Map<string, RequestEntry> => {
    let map = owners.get(ownerId);
    if (!map) {
      map = new Map();
      owners.set(ownerId, map);
    }
    return map;
  };

  const settle = (ownerId: string, requestId: string, entry: RequestEntry): void => {
    const map = owners.get(ownerId);
    // An old completion must not erase a new request after owner reuse.
    if (map?.get(requestId) === entry) {
      entry.settled = true;
      map.delete(requestId);
      if (map.size === 0) owners.delete(ownerId);
    }
  };

  return {
    async request(ownerId, requestId, options): Promise<NativeRequestResult> {
      if (disposed) return { errMsg: "request:fail service disposed" };
      if (owners.get(ownerId)?.has(requestId)) return { errMsg: "request:fail duplicate active requestId" };
      const controller = new AbortController();
      const entry: RequestEntry = { controller, settled: false };
      owner(ownerId).set(requestId, entry);

      try {
        const requestTracer = createRequestTracer(
          () => tracer,
          ownerId,
          requestId,
        );
        const result = await transport.request(
          requestId,
          options,
          controller.signal,
          requestTracer,
        );
        return result;
      } finally {
        settle(ownerId, requestId, entry);
      }
    },

    abort(ownerId, requestId): void {
      const entry = owners.get(ownerId)?.get(requestId);
      if (!entry || entry.settled) return;
      entry.controller.abort();
    },

    disposeOwner(ownerId): void {
      const map = owners.get(ownerId);
      if (!map) return;
      // Retire the old generation before observers can re-enter with a new one.
      owners.delete(ownerId);
      for (const entry of map.values()) {
        if (!entry.settled) entry.controller.abort();
      }
    },

    dispose(): void {
      disposed = true;
      for (const [ownerId, map] of Array.from(owners.entries())) {
        for (const entry of map.values()) {
          if (!entry.settled) entry.controller.abort();
        }
        owners.delete(ownerId);
      }
    },

    setTracer(next): void {
      tracer = next;
    },
  };
}

export type {
  NativeRequestOptions,
  NativeRequestResult,
  NativeRequestService,
} from "./types.js";
export { createNativeRequestTransport } from "./transport.js";
export {
  appendQueryParams,
  encodeBody,
  normalizeRequestHeaders,
} from "./normalize.js";
export type { NativeRequestTrace, NativeRequestTracer } from "./trace.js";
