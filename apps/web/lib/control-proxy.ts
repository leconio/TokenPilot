const forwardedHeaderNames = [
  "accept",
  "content-type",
  "cookie",
  "x-csrf-token",
  "x-request-id",
] as const;

export class ControlProxyOriginError extends Error {}

function firstHeaderValue(value: string | null): string | null {
  return value?.split(",", 1)[0]?.trim() || null;
}

function publicRequestOrigin(requestUrl: string, headers: Headers): string {
  const url = new URL(requestUrl);
  const protocol = firstHeaderValue(headers.get("x-forwarded-proto")) ?? url.protocol.slice(0, -1);
  const host = firstHeaderValue(headers.get("host")) ?? url.host;
  if (!new Set(["http", "https"]).has(protocol) || host.length === 0) {
    throw new ControlProxyOriginError("The request origin is invalid");
  }
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    throw new ControlProxyOriginError("The request origin is invalid");
  }
}

export function controlProxyRequestHeaders(requestUrl: string, incoming: Headers): Headers {
  const site = firstHeaderValue(incoming.get("sec-fetch-site"));
  if (site === "cross-site") {
    throw new ControlProxyOriginError("Cross-site control requests are not allowed");
  }

  const browserOrigin = firstHeaderValue(incoming.get("origin"));
  if (browserOrigin !== null) {
    let normalizedBrowserOrigin: string;
    try {
      normalizedBrowserOrigin = new URL(browserOrigin).origin;
    } catch {
      throw new ControlProxyOriginError("The browser origin is invalid");
    }
    if (normalizedBrowserOrigin !== publicRequestOrigin(requestUrl, incoming)) {
      throw new ControlProxyOriginError("Cross-origin control requests are not allowed");
    }
  }

  const outgoing = new Headers();
  for (const name of forwardedHeaderNames) {
    const value = incoming.get(name);
    if (value !== null) outgoing.set(name, value);
  }
  if (browserOrigin !== null || site === "same-origin") {
    outgoing.set("sec-fetch-site", "same-origin");
  }
  return outgoing;
}
