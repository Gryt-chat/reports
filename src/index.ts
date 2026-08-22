import consola from "consola";
import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

import { handleAdmin } from "./admin.ts";
import { checkAppKey, verifyIdentity } from "./auth.ts";
import { loadConfig, type Config } from "./config.ts";
import { closeDb, getReport, initDb, insertReport } from "./db.ts";
import {
  applyCors,
  clientIp,
  header,
  HttpError,
  readBody,
  sendJson,
} from "./http.ts";
import {
  assertNotBanned,
  assertWithinLimits,
  pruneOldEvents,
  recordSubmission,
  type Submitter,
} from "./limits.ts";
import { notify } from "./notify.ts";
import { oidcFrom, type OidcConfig } from "./oidc.ts";
import { newReportId, normaliseReport } from "./report.ts";
import { Triager } from "./triage.ts";

/**
 * Which door a request came in by.
 *
 * Ingest has to be reachable from anywhere — that is the entire job. The inbox
 * does not, and on one port the admin token would be the only thing between the
 * open internet and every report anyone has ever sent. So they are two
 * listeners, and the public one does not serve /admin at all.
 */
type Surface = "public" | "admin";

const startedAt = Date.now();

async function main(): Promise<void> {
  const config = loadConfig();
  initDb(config.dataDir);

  const triager = new Triager(config, (report) => {
    if (config.notifyOn === "triage") void notify(config, report);
  });
  triager.start();

  const oidc = oidcFrom(config);

  const server = http.createServer((req, res) => {
    void handle(req, res, config, triager, oidc, "public").catch((err) => {
      respondToError(res, err);
    });
  });

  const sameListener = config.adminPort === config.port;
  const adminServer = sameListener
    ? null
    : http.createServer((req, res) => {
        void handle(req, res, config, triager, oidc, "admin").catch((err) => {
          respondToError(res, err);
        });
      });

  const prune = setInterval(() => pruneOldEvents(Date.now()), 60 * 60 * 1000);
  prune.unref();

  server.listen(config.port, config.host, () => {
    consola.success(
      `[reports] ${config.version} taking reports on ${config.host}:${config.port}`,
    );
    consola.info(
      `[reports] ${config.appKeys.size} app key(s), signature ${
        config.requireSignature ? "required" : "optional"
      }`,
    );
  });

  adminServer?.listen(config.adminPort, config.adminHost, () => {
    consola.success(
      `[reports] inbox on ${config.adminHost}:${config.adminPort}` +
        (oidc ? `, sign in through ${oidc.issuer}` : ", admin token only"),
    );
  });

  const shutdown = (signal: string): void => {
    consola.info(`[reports] ${signal}, shutting down`);
    triager.stop();
    adminServer?.close();
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
  surface: Surface,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  applyCors(req, res, config.corsOrigins);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/" || url.pathname === "/healthz") {
    sendJson(res, 200, {
      service: "gryt-reports",
      version: config.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    });
    return;
  }

  if (url.pathname === "/v1/reports" && req.method === "POST") {
    // Only on the door it belongs to. The inbox listener taking reports would
    // work and would be one more thing to reason about when deciding what is
    // safe to expose.
    if (surface === "admin" && config.adminPort !== config.port) {
      throw new HttpError(404, "not_found", "No such endpoint");
    }
    await ingest(req, res, config, triager);
    return;
  }

  if (url.pathname.startsWith("/admin")) {
    // On the public port this is not "wrong token", it is "no such thing".
    // Anything reachable from the internet should not advertise that an inbox
    // exists behind it, let alone invite a guess at the token.
    if (surface === "public" && config.adminPort !== config.port) {
      throw new HttpError(404, "not_found", "No such endpoint");
    }
    await handleAdmin(req, res, url, config, oidc);
    return;
  }

  throw new HttpError(404, "not_found", "No such endpoint");
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
    ip: clientIp(req, config.trustProxy),
    appId,
    installId: report.app.installId,
    subject,
  };

  assertNotBanned(who, nowIso);
  assertWithinLimits(who, config.limits, now);

  const id = newReportId(now, randomBytes(4).toString("hex"));

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
