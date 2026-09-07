/**
 * Synthesize Chrome DevTools Protocol `Network.request*`/`Network.loading*`
 * messages from the main-process HTTP request trace stream (see
 * electron-runtime `native-request/trace.ts`).
 *
 * Why this exists: `wx.request` runs on Node http/https in the MAIN process
 * (see native-request's design notes — this replaced a renderer `fetch()`
 * specifically to stop Chromium's Fetch/CORS algorithm from attaching a
 * spurious OPTIONS preflight to it) — no `webContents.debugger` can observe
 * it, so the embedded DevTools Network tab would otherwise show nothing for
 * every wx.request call. The trace stream gives one ordered fact per
 * lifecycle moment; this module re-shapes each fact into the CDP events the
 * front-end already renders natively for an XHR-classified resource
 * (`requestWillBeSent` creates the row, `responseReceived` fills in
 * status/headers, `loadingFinished`/`loadingFailed` settles it).
 *
 * Ordering contract this module relies on (guaranteed by the trace layer):
 * `sent` strictly precedes every other event for its requestId, and exactly
 * one of `loadingFinished`/`loadingFailed` terminates each sent request. The
 * front-end silently drops loading events for an unknown requestId, so this
 * module mirrors that discipline defensively: any non-`sent` event for an
 * unknown requestId is dropped rather than synthesized.
 *
 * Pure and self-contained (no Electron imports) so it is unit-testable.
 */
import { NATIVE_HTTP_REQUEST_ID_PREFIX } from "./request-ids.js";
import { isUserFacingRequest } from "./user-facing.js";
import type { NativeRequestTrace } from "../../ipc/bridge-router.js";

/** One CDP message ready for `DevToolsAPI.dispatchMessage` injection. */
export interface SynthesizedRequestMessage {
  method: string;
  params: unknown;
  /**
   * The verdict `isUserFacingRequest` produced for this request's url at
   * `sent` time, cached for the request's whole lifetime — every later event
   * reuses it (they carry no url of their own). The user-facing sink gates
   * on this; the global mirror ignores it.
   */
  userFacing: boolean;
  /** Response body ready to prime the forwarder's body-cache, present only
   * on the message synthesized from a `finished` trace event. */
  body?: { base64Encoded: boolean; body: string };
  /** Request post data ready to prime the forwarder's post-data cache,
   * present only on the message synthesized from the `sent` trace event when
   * the request carried a body. */
  postData?: string;
}

export interface RequestTraceSynthesizerOptions {
  /** Per-forwarder instance tag keeping virtual ids collision-free. */
  epoch: string;
  /**
   * Origins the app itself serves (resource server / simulator shell), the
   * same inputs `resolveUserFacing` feeds `isUserFacingRequest` for
   * simulator-captured HTTP traffic. Re-read at each initial `sent`; redirects retain that verdict.
   */
  internalOrigins?: () => ReadonlyArray<string | null | undefined>;
}

interface RequestState {
  requestId: string;
  url: string;
  userFacing: boolean;
}

/** CDP `Network.ResourceType` this forwarder classifies every wx.request
 * call as — the same bucket the real front-end uses for `XMLHttpRequest`/
 * `fetch()` business calls, so it renders with the matching icon/filter. */
const RESOURCE_TYPE = "XHR";

export class RequestTraceSynthesizer {
  private readonly requests = new Map<string, RequestState>();
  private seq = 0;

  constructor(private readonly options: RequestTraceSynthesizerOptions) {}

  /**
   * Map one trace event to its CDP message, or null when the event must be
   * dropped (a non-`sent` event for a requestId this synthesizer never saw
   * sent — defensive against out-of-order delivery).
   */
  synthesize(
    sessionId: string,
    event: NativeRequestTrace,
  ): SynthesizedRequestMessage | null {
    const key = `${sessionId} ${event.requestId}`;
    if (event.type === "sent" || event.type === "redirect") {
      const previous = this.requests.get(key);
      if (event.type === "redirect" && !previous) return null;
      const requestId = event.type === "redirect" ? previous!.requestId
        : `${NATIVE_HTTP_REQUEST_ID_PREFIX}${this.options.epoch}:${this.seq++}`;
      const userFacing = event.type === "redirect" ? previous!.userFacing : isUserFacingRequest(
        event.url,
        this.options.internalOrigins?.(),
      );
      this.requests.set(key, { requestId, url: event.url, userFacing });
      const timestamp = event.time / 1000;
      const hasPostData = event.hasPostData ?? event.postData !== undefined;
      const message: SynthesizedRequestMessage = {
        method: "Network.requestWillBeSent",
        params: {
          requestId,
          loaderId: requestId,
          documentURL: event.url,
          request: {
            url: event.url,
            method: event.method,
            headers: event.headers,
            hasPostData,
            ...(hasPostData ? { postData: event.postData } : {}),
          },
          timestamp,
          wallTime: timestamp,
          initiator: { type: "script" },
          type: RESOURCE_TYPE,
          ...(event.type === "redirect" ? { redirectResponse: {
            ...event.redirectResponse,
            mimeType: mimeTypeOf(event.redirectResponse.headers),
            connectionReused: false, connectionId: 0, encodedDataLength: 0,
          } } : {}),
        },
        userFacing,
      };
      if (hasPostData) message.postData = event.postData;
      return message;
    }

    const state = this.requests.get(key);
    if (!state) return null;
    const { requestId, userFacing } = state;
    const timestamp = event.time / 1000;

    switch (event.type) {
      case "response":
        return {
          method: "Network.responseReceived",
          params: {
            requestId,
            loaderId: requestId,
            timestamp,
            type: RESOURCE_TYPE,
            response: {
              url: state.url,
              status: event.status,
              statusText: event.statusText,
              headers: event.headers,
              // Chromium uses these together to replace provisional headers
              // and expose the verbatim source. ExtraInfo has no raw request
              // text and would override this response snapshot in the frontend.
              ...(event.requestHeaders && event.requestHeadersText ? {
                requestHeaders: event.requestHeaders,
                requestHeadersText: event.requestHeadersText,
              } : {}),
              mimeType: mimeTypeOf(event.headers),
              connectionReused: false,
              connectionId: 0,
              encodedDataLength: 0,
              fromDiskCache: false,
              fromServiceWorker: false,
            },
          },
          userFacing,
        };
      case "finished":
        // Terminal: release the id mapping so a long-lived owner can't grow it.
        this.requests.delete(key);
        return {
          method: "Network.loadingFinished",
          params: {
            requestId,
            timestamp,
            encodedDataLength: event.encodedDataLength,
          },
          userFacing,
          ...(event.body !== undefined ? { body: { base64Encoded: event.bodyBase64Encoded, body: event.body } } : {}),
        };
      case "failed":
        this.requests.delete(key);
        return {
          method: "Network.loadingFailed",
          params: {
            requestId,
            timestamp,
            type: RESOURCE_TYPE,
            errorText: event.errorText,
          },
          userFacing,
        };
    }
  }
}

/** `Content-Type: application/json; charset=utf-8` → `application/json`. Case
 * -insensitive header lookup, matching HTTP semantics. */
function mimeTypeOf(headers: Record<string, string>): string {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "content-type") continue;
    return value.split(";")[0]?.trim() ?? "";
  }
  return "";
}
