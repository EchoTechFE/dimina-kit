import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  resolveTimeoutBudgetMs,
} from "../../../shared/request-core.js";
import { buildHeaders } from "../../../shared/request-encoding.js";

export { DEFAULT_REQUEST_TIMEOUT_MS, MAX_TIMEOUT_MS, resolveTimeoutBudgetMs };
export { encodeBody } from "../../../shared/request-encoding.js";

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
