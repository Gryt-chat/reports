import consola from "consola";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

/**
 * The dashboard: a built Vite app, served by the service that owns the data.
 *
 * Same origin as the API on purpose. The session cookie is simply sent, so
 * there is no token in JavaScript and nowhere for one to leak from — and no
 * CORS, no second deploy, no third place for the allowlist to be checked.
 *
 * If it was never built, everything here is inert and the plain pages answer
 * instead. That is what makes the plain pages worth keeping: a broken frontend
 * build cannot take the inbox down with it.
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
 * Everything the page is allowed to do.
 *
 * Wider than the plain pages', because this one runs its own JavaScript — but
 * only its own: no CDN, no inline script, no framing, and nothing it can talk
 * to except the origin it came from.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // data: as well as 'self', because @gryt/ui's compiled CSS embeds a face as a
  // data URI. Without it the library's own icon font is blocked and the console
  // fills with CSP violations — found by opening the page, not by reading it.
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
   * Serve an asset by path, or return false if there is nothing there.
   *
   * The path is resolved and then checked to still be inside the root, which is
   * the only thing standing between `/admin/assets/../../etc/passwd` and the
   * file it names.
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
      // `private`, not `public`. Vite hashes every asset filename so a year is
      // safe in the browser that fetched it — but these sit behind the session
      // now, and `public` invites every shared cache between here and there to
      // keep a copy and hand it to whoever asks next. Cloudflare did exactly
      // that: after the gate went in, the edge kept serving a copy it had
      // stored while the file was still open, and the origin refusing the
      // request made no difference to anybody who never reached it.
      //
      // index.html is not hashed and must never be stored at all, or a deploy
      // leaves people on a shell pointing at assets that no longer exist.
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
