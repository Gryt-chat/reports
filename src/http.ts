import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * Read a request body, refusing anything over `maxBytes`.
 *
 * The check is on bytes as they arrive rather than on Content-Length, because
 * Content-Length is whatever the sender says it is.
 */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new HttpError(413, "body_too_large", `Body over ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err) => reject(err));
  });
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(text);
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    // The admin inbox renders text strangers wrote. Nothing on the page needs
    // to load or run anything from anywhere.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(html);
}

/**
 * Who sent this.
 *
 * Behind the tunnel the socket address is the proxy, so the client address has
 * to come from a header — and a header is only worth reading when something in
 * front is known to set it, hence REPORTS_TRUST_PROXY. `cf-connecting-ip` is
 * the one Cloudflare sets and strips; the rightmost `x-forwarded-for` entry is
 * the one the nearest proxy appended, which is the only one it can vouch for.
 *
 * `trustedProxies` is what decides whether to believe any of it. The ingest
 * port is published on the machine's network address, so the tunnel is not the
 * only thing that can reach it — and anything else that can will happily send
 * `cf-connecting-ip: 1.2.3.4` and opt itself out of every per-address rate
 * limit and every ban. Listing the proxy means the header is only believed when
 * the proxy is the one that connected.
 */
export function clientIp(
  req: IncomingMessage,
  trustProxy: boolean,
  trustedProxies: string[] = [],
  onUnpinnedProxy?: (peer: string) => void,
): string {
  const peer = req.socket.remoteAddress || "unknown";
  const fromProxy =
    trustedProxies.length === 0 || trustedProxies.includes(normaliseIp(peer));

  if (trustProxy && fromProxy) {
    // Nothing else can see this. Working out which address to pin means either
    // reading it off the machine at the moment a request is in flight, or
    // guessing — and a wrong guess here is silent, because believing nobody
    // looks exactly like believing everybody until somebody lies.
    if (trustedProxies.length === 0 && onUnpinnedProxy && hasForwardingHeader(req)) {
      onUnpinnedProxy(normaliseIp(peer));
    }
    const cf = header(req, "cf-connecting-ip");
    if (cf) return cf;

    const real = header(req, "x-real-ip");
    if (real) return real;

    const forwarded = header(req, "x-forwarded-for");
    if (forwarded) {
      const parts = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1];
    }
  }
  return peer;
}

function hasForwardingHeader(req: IncomingMessage): boolean {
  return Boolean(
    header(req, "cf-connecting-ip") ??
      header(req, "x-real-ip") ??
      header(req, "x-forwarded-for"),
  );
}

/** ::ffff:192.0.2.1 and 192.0.2.1 are the same machine. */
export function normaliseIp(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

export function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value?.trim() || null;
}

export function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: string[],
): void {
  const origin = header(req, "origin");
  if (!origin) return;
  if (!allowed.includes(origin) && !allowed.includes("*")) return;

  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "origin");
  res.setHeader(
    "access-control-allow-headers",
    "content-type, x-gryt-app, x-gryt-app-key, x-gryt-identity",
  );
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-max-age", "86400");
}

/** HTML-escape, for the admin pages. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
