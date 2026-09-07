import type { NativeRequestTracer } from "./trace.js";

export interface NativeRequestOptions {
  url: string;
  /** Execution document supplied by the native bridge, never a renderer-global fallback. */
  baseUrl?: string;
  data?: unknown;
  header?: Record<string, string>;
  timeout?: number;
  method?: string;
  dataType?: string;
  responseType?: string;
}

export interface NativeRequestSuccessResult {
  data: unknown;
  statusCode: number;
  header: Record<string, string>;
  errMsg: "request:ok";
}

export interface NativeRequestFailResult {
  errMsg: string;
}

export type NativeRequestResult =
  | NativeRequestSuccessResult
  | NativeRequestFailResult;

export interface NativeRequestService {
  request(
    ownerId: string,
    requestId: string,
    options: NativeRequestOptions,
  ): Promise<NativeRequestResult>;
  abort(ownerId: string, requestId: string): void;
  disposeOwner(ownerId: string): void;
  dispose(): void;
  /** Register the single observer of the trace stream (devtools Network
   * panel). An absent tracer skips observation payloads and base64 encoding. */
  setTracer(tracer: NativeRequestTracer | undefined): void;
}
