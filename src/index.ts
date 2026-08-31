import consola from "consola";
import { randomBytes, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

import { handleAdmin } from "./admin.ts";
import { checkAppKey, verifyIdentity } from "./auth.ts";
import {
  knownVersions,
  MAX_CHANGELOG_BODY,
  parseDraft,
  receiveDraft,
  rejectionNotes,
  writePublicFile,
} from "./changelog.ts";
import { Dashboard } from "./dashboard.ts";
import { loadConfig, type Config } from "./config.ts";
import { closeDb, getReport, initDb, insertReport } from "./db.ts";
import { Digest } from "./digest.ts";
import {
  applyCors,
  clientIp,
  header,
  HttpError,
  isAllowedOrigin,
  readBody,
  sendJson,
} from "./http.ts";
import {
  assertWithinLimits,
  banFor,
  pruneOldEvents,
  recordBlocked,
  recordSubmission,
  type Submitter,
} from "./limits.ts";
import { notify } from "./notify.ts";
import { oidcFrom, type OidcConfig } from "./oidc.ts";
import { newReportId, normaliseReport } from "./report.ts";
import { Triager } from "./triage.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  initDb(config.dataDir);

  const triager = new Triager(config, (report) => {
    if (config.notifyOn === "triage") void notify(config, report);
  });
  triager.start();

  const digest = new Digest(config);
  digest.start();

  const oidc = oidcFrom(config);
  const dashboard = new Dashboard(config.uiDir);

  // Once at boot, so a container on a fresh volume serves a real file rather
  // than a 404 the changelog page has to treat as "no notes yet".
  if (config.changelog.file && writePublicFile(config)) {
    consola.info(`[reports] release notes written to ${config.changelog.file}`);
  }

  const server = http.createServer((req, res) => {
    void handle(req, res, config, triager, oidc, dashboard, digest).catch((err) => {
      respondToError(res, err);
    });
  });

  const prune = setInterval(() => pruneOldEvents(Date.now()), 60 * 60 * 1000);
  prune.unref();

  server.listen(config.port, config.host, () => {
    consola.success(
      `[reports] ${config.version} on ${config.host}:${config.port} — reports in, inbox at /admin`,
    );
    consola.info(
      `[reports] ${config.appKeys.size} app key(s), signature ${
        config.requireSignature ? "required" : "optional"
      }`,
    );

    if (config.trustProxy && config.trustedProxies.length === 0) {
      consola.warn(
        "[reports] Forwarding headers are believed from any peer. Anything " +
          "that can reach this port directly can name its own address and " +
          "opt out of every rate limit and ban. Set REPORTS_TRUSTED_PROXIES.",
      );
    }
  });

  consola.info(
    oidc ? `[reports] sign in through ${oidc.issuer}` : "[reports] admin token only",
  );

  const shutdown = (signal: string): void => {
    consola.info(`[reports] ${signal}, shutting down`);
    triager.stop();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  triager: Triager,
  oidc: OidcConfig | null,
  dashboard: Dashboard,
  digest: Digest,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  applyCors(req, res, config.corsOrigins);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/" || url.pathname === "/healthz") {
    // Alive, and nothing else. The name, the version and the uptime are the
    // first three things a scan writes down: together they say which release
    // is running and therefore which fixes are not in it. They are on
    // /admin/api/stats instead, where whoever is asking has signed in.
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/v1/reports" && req.method === "POST") {
    await ingest(req, res, config, triager);
    return;
  }

  if (url.pathname.startsWith("/v1/changelog")) {
    await changelog(req, res, url, config);
    return;
  }

  if (url.pathname.startsWith("/admin")) {
    await handleAdmin(req, res, url, config, oidc, dashboard, triager.model, digest);
    return;
  }

  throw new HttpError(404, "not_found", "No such endpoint");
}

/**
 * Take a drafted release note, or say which versions already have one.
 *
 * Not part of the report endpoint and not behind an app key: the drafter is a
 * script on the same machine, not one of the apps, and the two should not share
 * a credential — an app key is shipped inside a public binary, and this one
 * writes to a page.
 *
 * Deliberately absent from the CORS allow-list. Nothing in a browser has any
 * business posting a release note, so a page that tries is stopped before the
 * key is even considered.
 */
async function changelog(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: Config,
): Promise<void> {
  const expected = config.changelog.key;
  if (!expected) {
    throw new HttpError(404, "not_found", "Nothing configured to guard drafted notes");
  }

  const given = header(req, "x-gryt-changelog-key");
  if (!given || !keyMatches(given, expected)) {
    throw new HttpError(401, "unauthorised", "X-Gryt-Changelog-Key is wrong or missing");
  }

  // What the drafter asks before it spends eight minutes of GPU on a release.
  if (url.pathname === "/v1/changelog/versions" && req.method === "GET") {
    sendJson(res, 200, { versions: knownVersions() });
    return;
  }

  // And what it asks before writing one it has been asked to write again.
  if (url.pathname === "/v1/changelog/feedback" && req.method === "GET") {
    sendJson(res, 200, { feedback: rejectionNotes() });
    return;
  }

  if (url.pathname !== "/v1/changelog" || req.method !== "POST") {
    throw new HttpError(404, "not_found", "No such endpoint");
  }

  const raw = (await readBody(req, MAX_CHANGELOG_BODY)).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "null");
  } catch {
    throw new HttpError(400, "invalid_json", "Body is not valid JSON");
  }

  const draft = parseDraft(parsed);
  const result = receiveDraft(draft, {
    force: url.searchParams.get("force") === "1",
    now: new Date().toISOString(),
  });

  if (result.created) {
    consola.info(`[changelog] ${draft.version} drafted, waiting to be read`);
    // So it is readable at /changelog?drafts=1 straight away, which is where
    // a note is easiest to judge — rendered, on the page it would go on.
    writePublicFile(config);
  }

  sendJson(res, result.created ? 201 : 200, {
    id: result.id,
    version: draft.version,
    status: result.status,
    created: result.created,
  });
}

function keyMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Take a report.
 *
 * The order matters: what the request claims about itself is checked before
 * anything is parsed, and the body is only counted against a rate limit once
 * it is going to be stored. A report that fails validation should not use up
 * somebody's hourly allowance — the app is usually the one at fault.
 */
async function ingest(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  triager: Triager,
): Promise<void> {
  // A browser that was told to post here by somebody else's page.
  //
  // Only browsers send an Origin, so this is not a check a native client can
  // fail — the mobile app sends none. It is not a check the *desktop* app
  // escapes, though: it serves its own UI over loopback, so its renderer sends
  // one like any other page. `isAllowedOrigin` is where that is handled.
  //
  // What this stops is a page on the open web making somebody's browser file
  // reports: CORS already stops that page reading the answer, but the report
  // lands in the table either way, and that is the part worth refusing.
  const origin = header(req, "origin");
  if (origin && !isAllowedOrigin(origin, config.corsOrigins)) {
    throw new HttpError(403, "origin_not_allowed", "Not a place reports come from");
  }

  const raw = await readBody(req, config.maxBodyBytes);

  const appId = checkAppKey(
    header(req, "x-gryt-app"),
    header(req, "x-gryt-app-key"),
    config.appKeys,
    config.allowUnkeyed,
  );

  const assertion = header(req, "x-gryt-identity");
  let subject: string | null = null;
  if (assertion) {
    subject = (await verifyIdentity(assertion, raw)).subject;
  } else if (config.requireSignature) {
    throw new HttpError(401, "signature_required", "X-Gryt-Identity is required");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Body is not valid JSON");
  }

  const report = normaliseReport(parsed, appId, config);

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const who: Submitter = {
    ip: clientIp(req, config.trustProxy, config.trustedProxies, nameTheProxy),
    appId,
    installId: report.app.installId,
    subject,
  };

  const id = newReportId(now, randomBytes(4).toString("hex"));

  // A banned submitter is thanked and ignored.
  //
  // The 403 this used to return told somebody they had been banned, which is
  // the one piece of information that makes a ban worth working around: it
  // says the address or the install they just used is the one to change, and
  // it says it immediately after each attempt, which is a free oracle for
  // finding an identifier that still works.
  //
  // So the answer is the same 202 and the same shape of id as an accepted
  // report. Nothing is stored. The attempt is counted, both against the ban —
  // so the inbox can say whether it is still absorbing anything — and against
  // the ordinary buckets, so switching networks arrives with part of the new
  // address's budget already spent.
  const ban = banFor(who, nowIso);
  if (ban) {
    recordBlocked(who, ban, now);
    consola.info(`[reports] ${ban.kind} ban ${ban.id} swallowed a ${report.type}`);
    sendJson(res, 202, { id, receivedAt: nowIso });
    return;
  }

  assertWithinLimits(who, config.limits, now);

  insertReport({
    id,
    receivedAt: nowIso,
    type: report.type,
    title: report.title,
    message: report.message,
    contact: report.contact,
    appId,
    appVersion: report.app.version,
    appBuild: report.app.build,
    appChannel: report.app.channel,
    appCommit: report.app.commit,
    installId: report.app.installId,
    platform: report.device.platform,
    osVersion: report.device.osVersion,
    deviceModel: report.device.model,
    identitySubject: subject,
    ip: who.ip,
    userAgent: report.runtime.userAgent ?? header(req, "user-agent"),
    payload: JSON.stringify(report),
  });

  recordSubmission(who, now);

  consola.info(`[reports] ${id} ${report.type} from ${appId} ${report.app.version ?? "?"}`);

  sendJson(res, 202, { id, receivedAt: nowIso });

  // Everything past here is for us, not for the person who just pressed send.
  if (config.notifyOn === "receive") {
    const stored = getReport(id);
    if (stored) void notify(config, stored);
  }
  void triager.tick();
}

/**
 * Say which address the forwarding header was believed from, once.
 *
 * The startup warning says the header is trusted from anyone and that
 * REPORTS_TRUSTED_PROXIES should be set — and then leaves whoever reads it to
 * work out what to set it to, which needs a packet capture or a lucky guess.
 * The service is the only thing that can see the answer, so it says it.
 *
 * Once per address, because this is a fact about the deployment rather than an
 * event, and repeating it every request would bury the reports.
 */
const namedProxies = new Set<string>();

function nameTheProxy(peer: string): void {
  if (namedProxies.has(peer)) return;
  namedProxies.add(peer);
  consola.warn(
    `[reports] Believed a forwarding header from ${peer}. If that is the ` +
      `proxy, set REPORTS_TRUSTED_PROXIES=${peer} and it will stop being ` +
      "believed from anywhere else.",
  );
}

function respondToError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return;

  if (err instanceof HttpError) {
    const headers: Record<string, string> = {};
    if (typeof err.extra.retryAfter === "number") {
      headers["retry-after"] = String(err.extra.retryAfter);
    }
    sendJson(res, err.status, { error: err.code, message: err.message }, headers);
    return;
  }

  consola.error("[reports] Unhandled error", err);
  sendJson(res, 500, { error: "internal", message: "Something went wrong" });
}

main().catch((err) => {
  consola.error("[reports] Failed to start", err);
  process.exit(1);
});
