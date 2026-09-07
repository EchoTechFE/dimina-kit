/**
 * Behavior tests for `createNetworkForwarder(...).reportNativeRequestTrace`.
 *
 * `RequestTraceSynthesizer` (http.test.ts) already covers the pure trace →
 * CDP message mapping; these tests cover the forwarder-level glue that
 * `websocket`'s equivalent path doesn't need: priming the SAME body/post-data
 * caches a simulator-CDP prefetch would populate, so the front-end's Get
 * Response Body / Get Request Post Data clicks resolve for a virtual
 * `dimina:http:` requestId without a debugger round-trip (there is none for
 * main-process traffic).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNetworkForwarder } from "./index.js";
import type { NativeRequestTrace } from "../../ipc/bridge-router.js";

// The synthesizer mints its virtual-id epoch from `Date.now()` at forwarder
// construction. Pinning the clock makes the first virtual id for any fresh
// forwarder in these tests deterministic — `dimina:http:<EPOCH>:0` — without
// reaching into the module's internal id scheme.
const EPOCH_TIME = 1_700_000_000_000;
const FIRST_VIRTUAL_ID = `dimina:http:${EPOCH_TIME}:0`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

function sent(
  requestId: string,
  url: string,
  method = "GET",
  postData?: string,
): NativeRequestTrace {
  return postData === undefined
    ? { type: "sent", requestId, url, method, headers: {}, time: Date.now() }
    : {
        type: "sent",
        requestId,
        url,
        method,
        headers: {},
        postData,
        time: Date.now(),
      };
}

describe("createNetworkForwarder — reportNativeRequestTrace", () => {
  it("primes the response-body cache at finished so getResponseBody resolves without a debugger round-trip", async () => {
    const fwd = createNetworkForwarder({ getServiceWc: () => null });
    fwd.reportNativeRequestTrace(
      "owner-1",
      sent("r1", "https://business.example.com/api"),
    );
    fwd.reportNativeRequestTrace("owner-1", {
      type: "finished",
      requestId: "r1",
      body: Buffer.from('{"a":1}').toString("base64"),
      bodyBase64Encoded: true,
      encodedDataLength: 7,
      time: Date.now(),
    });

    const body = await fwd.bodies.getResponseBody(FIRST_VIRTUAL_ID);
    expect(body.base64Encoded).toBe(true);
    expect(Buffer.from(body.body, "base64").toString("utf-8")).toBe('{"a":1}');
  });

  it("primes the post-data cache at sent when the request carried a body", async () => {
    const fwd = createNetworkForwarder({ getServiceWc: () => null });
    fwd.reportNativeRequestTrace(
      "owner-1",
      sent("r1", "https://business.example.com/api", "POST", '{"a":1}'),
    );

    const postData = await fwd.bodies.getRequestPostData(FIRST_VIRTUAL_ID);
    expect(postData.postData).toBe('{"a":1}');
  });

  it("does not prime the post-data cache for a bodyless GET", async () => {
    const fwd = createNetworkForwarder({ getServiceWc: () => null });
    fwd.reportNativeRequestTrace(
      "owner-1",
      sent("r1", "https://business.example.com/api"),
    );

    await expect(
      fwd.bodies.getRequestPostData(FIRST_VIRTUAL_ID),
    ).rejects.toThrow();
  });

  it("a failed request never primes the body cache", async () => {
    const fwd = createNetworkForwarder({ getServiceWc: () => null });
    fwd.reportNativeRequestTrace(
      "owner-1",
      sent("r1", "https://business.example.com/api"),
    );
    fwd.reportNativeRequestTrace("owner-1", {
      type: "failed",
      requestId: "r1",
      errorText: "request:fail timeout",
      time: Date.now(),
    });

    await expect(
      fwd.bodies.getResponseBody(FIRST_VIRTUAL_ID),
    ).rejects.toThrow();
  });

  it("never throws for a trace event with no matching sent (defensive against out-of-order delivery)", () => {
    const fwd = createNetworkForwarder({ getServiceWc: () => null });
    expect(() =>
      fwd.reportNativeRequestTrace("owner-1", {
        type: "response",
        requestId: "ghost",
        status: 200,
        statusText: "OK",
        headers: {},
        time: Date.now(),
      }),
    ).not.toThrow();
  });

  it("is a no-op after dispose (no throw, no cache write)", async () => {
    const fwd = createNetworkForwarder({ getServiceWc: () => null });
    fwd.dispose();
    expect(() =>
      fwd.reportNativeRequestTrace(
        "owner-1",
        sent("r1", "https://business.example.com/api"),
      ),
    ).not.toThrow();
    await expect(
      fwd.bodies.getResponseBody(FIRST_VIRTUAL_ID),
    ).rejects.toThrow();
  });
});
