import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  resolveTimeoutBudgetMs,
} from "../../../shared/request-core.js";

export { DEFAULT_REQUEST_TIMEOUT_MS, MAX_TIMEOUT_MS, resolveTimeoutBudgetMs };

function buildHeaders(
  header: Record<string, string> | undefined,
  willSendBody: boolean,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(header ?? {})) {
    if (value != null) headers.set(key, String(value));
  }
  if (willSendBody && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  return headers;
}

export function normalizeRequestHeaders(
  header: Record<string, string> | undefined,
  method: string,
  data: unknown,
): Headers {
  const upper = method.toUpperCase();
  const canHaveBody = upper !== "GET" && upper !== "HEAD";
  const willSendBody = canHaveBody && data != null;
  return buildHeaders(header, willSendBody);
}

export function appendQueryParams(
  url: string,
  data: Record<string, unknown>,
  baseUrl?: string,
): string {
  const resolved = new URL(url, baseUrl);
  for (const [key, value] of Object.entries(data)) {
    resolved.searchParams.append(key, String(value));
  }
  return resolved.toString();
}

export function encodeBody(data: unknown, contentType: string): string {
  if (typeof data === "string") return data;
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(
      data as Record<string, unknown>,
    )) {
      form.append(key, String(value));
    }
    return form.toString();
  }
  return JSON.stringify(data);
}
