/**
 * The `window.wx.request` shim `setupApiCompatHook()` installs must align
 * with wx.request's HTTP-status-agnostic contract: any received response —
 * including 401 — resolves via `success` with a full `{ statusCode, … }`
 * object, never `fail`.
 *
 * After the migration to the main-process native HTTP transport, the shim
 * forwards calls through `ipcRenderer.invoke(BRIDGE_CHANNELS.NATIVE_REQUEST, …)`
 * and receives a result object that already carries the wx.request shape. No
 * `fetch()` runs in the renderer, so the CORS/preflight issue cannot appear here.
 *
 * Environment: jsdom (this package's default vitest environment).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipcRenderer } from "electron";
import { setupApiCompatHook } from "./api-compat";
import { BRIDGE_CHANNELS } from "../../shared/bridge-channels.js";
import type {
  RequestFailResult,
  RequestSuccessResult,
} from "../../shared/request-core.js";

vi.mock("electron", () => ({
  ipcRenderer: {
    invoke: vi.fn().mockResolvedValue({}),
    send: vi.fn(),
  },
}));

type WxWindow = Window & { wx?: Record<string, unknown> };

beforeEach(() => {
  (window as WxWindow).wx = {};
  vi.mocked(ipcRenderer.invoke).mockReset().mockResolvedValue({});
  vi.mocked(ipcRenderer.send).mockReset();
});

afterEach(() => {
  delete (window as WxWindow).wx;
  vi.restoreAllMocks();
});

async function flushAsyncTurns(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** Call the installed wx.request shim and drain the IPC response chain. */
async function callWxRequest(opts: Record<string, unknown>): Promise<{
  requestId: string;
  forwarded: Record<string, unknown>;
}> {
  setupApiCompatHook();
  const wx = (window as WxWindow).wx as {
    request: (o: Record<string, unknown>) => unknown;
  };
  wx.request(opts);
  await flushAsyncTurns(1);

  const [channel, requestId, forwarded] = vi.mocked(ipcRenderer.invoke).mock
    .calls[0] as [string, string, Record<string, unknown>];
  expect(channel).toBe(BRIDGE_CHANNELS.NATIVE_REQUEST);
  return { requestId, forwarded };
}

describe("wx.request shim (api-compat) — HTTP status never decides success vs fail", () => {
  it("a 401 response invokes success (not fail) with statusCode 401", async () => {
    vi.mocked(ipcRenderer.invoke).mockResolvedValue({
      statusCode: 401,
      data: {},
      header: {},
      errMsg: "request:ok",
    });
    const success = vi.fn<(res: RequestSuccessResult) => void>();
    const fail = vi.fn<(err: RequestFailResult) => void>();

    await callWxRequest({ url: "https://example.com/api", success, fail });
    await flushAsyncTurns();

    expect(fail).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledTimes(1);
    expect(success.mock.calls[0][0].statusCode).toBe(401);
  });

  it("a network failure result invokes fail and complete", async () => {
    vi.mocked(ipcRenderer.invoke).mockResolvedValue({
      errMsg: "request:fail network error",
    });
    const success = vi.fn<(res: RequestSuccessResult) => void>();
    const fail = vi.fn<(err: RequestFailResult) => void>();
    const complete =
      vi.fn<(res: RequestSuccessResult | RequestFailResult) => void>();

    await callWxRequest({
      url: "https://example.com/api",
      success,
      fail,
      complete,
    });
    await flushAsyncTurns();

    expect(success).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("a rejected IPC invoke invokes fail and complete", async () => {
    vi.mocked(ipcRenderer.invoke).mockRejectedValue(new Error("ipc broken"));
    const fail = vi.fn<(err: RequestFailResult) => void>();
    const complete =
      vi.fn<(res: RequestSuccessResult | RequestFailResult) => void>();

    await callWxRequest({ url: "https://example.com/api", fail, complete });
    await flushAsyncTurns();

    expect(fail).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(String(fail.mock.calls[0][0].errMsg)).toContain("ipc broken");
  });
});

describe("wx.request shim (api-compat) — forwarded options", () => {
  it("forwards the option bag to the main-process handler unchanged", async () => {
    const { forwarded } = await callWxRequest({
      url: "https://example.com/api",
      method: "POST",
      header: { "x-token": "abc" },
      data: { a: 1 },
      timeout: 3000,
      dataType: "json",
      responseType: "text",
    });

    expect(forwarded).toMatchObject({
      url: "https://example.com/api",
      method: "POST",
      header: { "x-token": "abc" },
      data: { a: 1 },
      timeout: 3000,
      dataType: "json",
      responseType: "text",
    });
  });

  it("forwards only the provided option fields", async () => {
    const { forwarded } = await callWxRequest({
      url: "https://example.com/api",
      method: "GET",
    });

    expect(forwarded).toMatchObject({
      url: "https://example.com/api",
      method: "GET",
    });
  });
});

describe("wx.request shim (api-compat) — return value", () => {
  it("returns a request task exposing abort() as a function", async () => {
    setupApiCompatHook();
    const wx = (window as WxWindow).wx as {
      request: (o: Record<string, unknown>) => { abort?: unknown };
    };

    const task = wx.request({ url: "https://example.com/api" });
    expect(typeof task.abort).toBe("function");
  });

  it("task.abort() sends the matching requestId on the native-request-abort channel", async () => {
    setupApiCompatHook();
    const wx = (window as WxWindow).wx as {
      request: (o: Record<string, unknown>) => { abort: () => void };
    };

    const task = wx.request({ url: "https://example.com/api" });
    const requestId = vi.mocked(ipcRenderer.invoke).mock.calls[0][1];
    task.abort();

    expect(ipcRenderer.send).toHaveBeenCalledWith(
      BRIDGE_CHANNELS.NATIVE_REQUEST_ABORT,
      requestId,
    );
  });
});
