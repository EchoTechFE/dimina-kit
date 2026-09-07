/** Shared wire encoding for the native transport and the published fetch helper. */
export function buildHeaders(
  header: Record<string, string> | undefined,
  willSendBody: boolean,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(header ?? {})) {
    if (value != null) headers.set(key, String(value));
  }
  // A bodyless request needs no default content type; explicit caller values win.
  if (willSendBody && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  return headers;
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
