import http from "node:http";
import https from "node:https";
import type {
  NativeRequestFailResult,
  NativeRequestOptions,
  NativeRequestResult,
  NativeRequestSuccessResult,
} from "./types.js";
import {
  appendQueryParams,
  encodeBody,
  normalizeRequestHeaders,
  resolveTimeoutBudgetMs,
} from "./normalize.js";
import type { RequestTracer } from "./trace.js";
import { decodeContent, decodeResponseData } from "./response.js";
import { captureRequestHeaders } from "./request-headers.js";

export interface NativeRequestTransport {
  request(
    requestId: string,
    options: NativeRequestOptions,
    signal: AbortSignal,
    tracer?: RequestTracer,
  ): Promise<NativeRequestSuccessResult | NativeRequestFailResult>;
}

export function createNativeRequestTransport(): NativeRequestTransport {
  return {
    request(_requestId, options, signal, tracer) {
      return new Promise<NativeRequestResult>((resolve) => {
        if (signal.aborted) {
          resolve({ errMsg: "request:fail abort" });
          return;
        }
        let method = (options.method || "GET").toUpperCase();
        const canHaveBody = method !== "GET" && method !== "HEAD";

        let resolvedUrl: URL;
        try {
          resolvedUrl = new URL(options.url, options.baseUrl);
        } catch (error) {
          resolve({
            errMsg: `request:fail ${error instanceof Error ? error.message : "invalid url"}`,
          });
          return;
        }

        const headers = normalizeRequestHeaders(
          options.header,
          method,
          options.data,
        );
        let url = resolvedUrl.toString();

        if (!canHaveBody) {
          if (options.data && typeof options.data === "object") {
            url = appendQueryParams(
              url,
              options.data as Record<string, unknown>,
            );
          }
        }

        const nodeHeaders: Record<string, string> = {};
        headers.forEach((value, key) => {
          nodeHeaders[key] = value;
        });

        nodeHeaders["accept-encoding"] ??= "gzip, deflate, br";
        let postDataForTrace: string | undefined;
        if (canHaveBody && options.data != null) {
          const contentType = headers.get("content-type") ?? "";
          postDataForTrace = encodeBody(options.data, contentType);
        }
        tracer?.sent(url, method, nodeHeaders, postDataForTrace);

        let settled = false;
        let req: http.ClientRequest | undefined;
        let response: http.IncomingMessage | undefined;
        const deadline = setTimeout(() => {
          fail("timeout");
        }, resolveTimeoutBudgetMs(options.timeout));
        function fail(reason: string): void {
          if (settled) return;
          finish({ errMsg: `request:fail ${reason}` });
          response?.destroy();
          req?.destroy();
        }
        function finish(result: NativeRequestResult): void {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          signal.removeEventListener("abort", abortRequest);
          if ("statusCode" in result) {
            const buffer = lastResponseBuffer ?? Buffer.alloc(0);
            tracer?.finished(
              () => buffer.toString("base64"),
              true,
              encodedDataLength,
              buffer.byteLength,
            );
          } else {
            tracer?.failed(result.errMsg);
          }
          resolve(result);
        }

        let lastResponseBuffer: Buffer | undefined;
        let encodedDataLength = 0;
        let generation = 0;
        let redirects = 0;

        function startHop(): void {
          if (settled) return;
          const hop = ++generation;
          try {
            const parsed = new URL(url);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
              throw new Error("unsupported request protocol");
            }
            const nodeModule = parsed.protocol === "https:" ? https : http;
            req = nodeModule.request(url, { method, headers: nodeHeaders }, (res) => {
              if (settled || hop !== generation) { res.destroy(); return; }
              response = res;
              res.on("error", (error) => { if (hop === generation) fail(error.message || "response interrupted"); });
              res.on("aborted", () => { if (hop === generation) fail("response aborted"); });
              const responseHeaders = Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [
                key, Array.isArray(value) ? value.join(", ") : value ?? "",
              ]));
              const status = res.statusCode ?? 0;
              const requestHeaders = tracer ? captureRequestHeaders(req) : undefined;
              if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
                try {
                  if (redirects++ >= 20) throw new Error("too many redirects");
                  const nextUrl = new URL(res.headers.location, url);
                  if (!["http:", "https:"].includes(nextUrl.protocol) || nextUrl.username || nextUrl.password) {
                    throw new Error("unsupported redirect URL");
                  }
                  const redirectResponse = { url, status, statusText: res.statusMessage ?? "", headers: responseHeaders, ...requestHeaders };
                  if (nextUrl.origin !== parsed.origin) {
                    for (const key of ["authorization", "proxy-authorization", "cookie", "host"]) delete nodeHeaders[key];
                  }
                  if (([301, 302].includes(status) && method === "POST") || (status === 303 && method !== "GET" && method !== "HEAD")) {
                    method = "GET";
                    postDataForTrace = undefined;
                    for (const key of ["content-type", "content-length", "content-encoding", "content-language", "content-location", "transfer-encoding"]) delete nodeHeaders[key];
                  }
                  url = nextUrl.toString();
                  tracer?.redirect(url, method, nodeHeaders, postDataForTrace, redirectResponse);
                  // Retire this hop before destroying it; late socket errors cannot fail its successor.
                  generation++;
                  res.destroy();
                  response = undefined;
                  startHop();
                } catch (error) {
                  fail(error instanceof Error ? error.message : "invalid redirect");
                }
                return;
              }
              tracer?.response(status, res.statusMessage ?? "", responseHeaders, requestHeaders);
              if (settled) return;
              const chunks: Buffer[] = [];
              res.on("data", (chunk: Buffer) => chunks.push(chunk));
              res.on("end", () => {
                if (settled || hop !== generation) return;
                const wireBody = Buffer.concat(chunks);
                encodedDataLength = wireBody.byteLength;
                void decodeContent(wireBody, responseHeaders["content-encoding"] ?? "").then((buffer) => {
                  if (settled || hop !== generation) return;
                  lastResponseBuffer = buffer;
                  finish({ data: decodeResponseData(buffer, options.dataType, options.responseType),
                    statusCode: status, header: responseHeaders, errMsg: "request:ok" });
                }).catch((error: unknown) => fail(error instanceof Error ? error.message : "invalid response body"));
              });
            });
            req.on("error", (error) => { if (hop === generation) fail(signal.aborted ? "abort" : error.message || "network error"); });
            if (postDataForTrace !== undefined) req.write(postDataForTrace);
            req.end();
          } catch (error) {
            fail(error instanceof Error ? error.message : "invalid request");
          }
        }
        signal.addEventListener("abort", abortRequest, { once: true });
        if (signal.aborted) abortRequest();
        else startHop();

        function abortRequest(): void { fail("abort"); }
      }).catch((error: unknown) => ({
        errMsg: `request:fail ${error instanceof Error ? error.message : "invalid request"}`,
      }));
    },
  };
}
