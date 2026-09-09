import consola from "consola";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

/**
 * The dashboard: a built Vite app, served by the service that owns the data. Same origin, so
 * no token in JavaScript. If it was never built, everything here is inert.
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

/**
 * Everything the page is allowed to do. Wider than the plain pages', because this one runs
 * its own JavaScript — and only its own: no CDN, no inline script, no framing.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // data: as well as 'self', because @gryt/ui's compiled CSS embeds a face as a data URI.
  // Without it the icon font is blocked — found by opening the page, not by reading it.
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export class Dashboard {
  private readonly root: string | null;

  constructor(dir: string) {
    const root = resolve(dir);
    if (existsSync(join(root, "index.html"))) {
      this.root = root;
      consola.info(`[dashboard] Serving the built dashboard from ${root}`);
    } else {
      this.root = null;
      consola.info("[dashboard] Not built — /admin serves the plain pages");
    }
  }

  get available(): boolean {
    return this.root !== null;
  }

  /**
   * Serve an asset by path, or return false if there is nothing there. The path is resolved
   * and then checked to still be inside the root, which is the whole guard.
   */
  asset(res: ServerResponse, pathname: string): boolean {
    if (!this.root) return false;

    const relative = normalize(pathname.replace(/^\/admin\//, "")).replace(/^(\.\.[/\\])+/, "");
    const file = resolve(this.root, relative);

    if (file !== this.root && !file.startsWith(this.root + sep)) return false;
    if (!existsSync(file)) return false;

    const stat = statSync(file);
    if (!stat.isFile()) return false;

    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";

    res.writeHead(200, {
      "content-type": type,
      "content-length": stat.size,
      // `private`, not `public`: these sit behind the session, and Cloudflare kept a copy
      // and served it. index.html is not hashed and must never be stored at all.
      "cache-control": file.endsWith("index.html")
        ? "no-store"
        : "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });

    createReadStream(file).pipe(res);
    return true;
  }

  /** The shell, for any route the dashboard owns. */
  shell(res: ServerResponse): boolean {
    if (!this.root) return false;

    const file = join(this.root, "index.html");
    const stat = statSync(file);

    res.writeHead(200, {
      "content-type": TYPES[".html"],
      "content-length": stat.size,
      "cache-control": "no-store",
      "content-security-policy": CSP,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });

    createReadStream(file).pipe(res);
    return true;
  }
}
