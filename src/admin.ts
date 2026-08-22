import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Config } from "./config.ts";
import {
  addAdmin,
  addBan,
  countAdmins,
  countReports,
  findAdmin,
  listAdmins,
  removeAdmin,
  touchAdmin,
  type AdminRow,
  getReport,
  isReportStatus,
  listBans,
  listReports,
  markRead,
  removeBan,
  REPORT_STATUSES,
  resetTriage,
  setStatus,
  stats,
  type BanKind,
  type ReportRow,
  type ReportStatus,
  type ReportSummary,
  type ReportType,
  type TriageStatus,
} from "./db.ts";
import type { Dashboard } from "./dashboard.ts";
import { esc, header, HttpError, readBody, sendHtml, sendJson } from "./http.ts";
import {
  completeLogin,
  readSession,
  signSession,
  startLogin,
  type OidcConfig,
  type Person,
} from "./oidc.ts";

const COOKIE = "gryt_reports_admin";
const SESSION_COOKIE = "gryt_reports_session";
const LOGIN_COOKIE = "gryt_reports_login";
const PAGE_SIZE = 50;

/**
 * Who is asking.
 *
 * A person signed in with their Gryt account, or a script holding the static
 * token. Both may read the inbox; only a person shows up in the page header,
 * and only a person can be taken off the list later.
 */
type Actor =
  | { kind: "token" }
  | { kind: "person"; subject: string; name: string };

/**
 * The inbox.
 *
 * Server-rendered, no build step and no client JavaScript, because the whole
 * page is text strangers typed and the fewer ways there are to run something,
 * the better. The JSON routes underneath it are the same data for anything
 * that would rather read it than look at it.
 */
export async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: Config,
  oidc: OidcConfig | null,
  dashboard: Dashboard | null,
): Promise<void> {
  if (!config.adminToken && !oidc) {
    throw new HttpError(404, "not_found", "Nothing configured to guard the inbox");
  }

  const path = url.pathname.replace(/\/+$/, "") || "/admin";

  if (oidc) {
    if (path === "/admin/login") {
      await sendToKeycloak(res, oidc);
      return;
    }
    if (path === "/admin/callback") {
      await returnFromKeycloak(req, res, url, oidc);
      return;
    }
    if (path === "/admin/logout") {
      res.writeHead(303, {
        "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=0`,
        location: "/admin/login",
      });
      res.end();
      return;
    }
  }

  // Signing in with the static token is one link with it on. It is swapped for
  // a cookie immediately so it stops turning up in history and referrers. Only
  // when nothing better is configured — with Keycloak on, people sign in and
  // the token is for scripts.
  const queryToken = url.searchParams.get("token");
  if (queryToken && config.adminToken && !oidc) {
    if (!tokenMatches(queryToken, config.adminToken)) {
      throw new HttpError(401, "unauthorised", "Wrong token");
    }
    res.writeHead(302, {
      "set-cookie": `${COOKIE}=${encodeURIComponent(queryToken)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=2592000`,
      location: path,
    });
    res.end();
    return;
  }

  const actor = authorise(req, config, oidc);
  if (!actor) {
    // A browser gets sent to sign in. Anything asking for JSON, or holding a
    // wrong token, gets told plainly rather than handed a redirect to parse.
    if (oidc && req.method === "GET" && !path.startsWith("/admin/api")) {
      res.writeHead(302, { location: "/admin/login" });
      res.end();
      return;
    }
    throw new HttpError(401, "unauthorised", "Sign in, or send the admin token");
  }

  if (req.method === "POST") {
    await handlePost(req, res, path, config, actor);
    return;
  }

  if (req.method !== "GET") {
    throw new HttpError(405, "method_not_allowed", "GET or POST");
  }

  // Behind the auth check with everything else. These were served in front of
  // it on the theory that the sign-in page needed them to style itself — it
  // does not, because the sign-in page is Keycloak's.
  if (dashboard?.available && path.startsWith("/admin/assets/")) {
    if (dashboard.asset(res, url.pathname)) return;
    throw new HttpError(404, "not_found", "No such asset");
  }

  // The dashboard owns the routes a person opens. The plain pages are still
  // there under /admin/plain — they are the fallback when a build is broken,
  // and they cost nothing to keep.
  const plain = path.startsWith("/admin/plain");
  if (dashboard?.available && !plain && !path.startsWith("/admin/api")) {
    if (path === "/admin" || /^\/admin\/(reports\/[\w-]+|people)$/.test(path)) {
      markReadFor(path);
      if (dashboard.shell(res)) return;
    }
  }

  if (path === "/admin/api/stats") {
    sendJson(res, 200, stats());
    return;
  }

  if (path === "/admin/api/bans") {
    sendJson(res, 200, { bans: listBans() });
    return;
  }

  if (path === "/admin/api/people") {
    sendJson(res, 200, { people: listAdmins() });
    return;
  }

  if (path === "/admin/people" || path === "/admin/plain/people") {
    sendHtml(res, 200, peoplePage(listAdmins(), actor, oidc));
    return;
  }

  if (path === "/admin/api/reports") {
    const filter = filterFrom(url);
    sendJson(res, 200, {
      total: countReports(filter),
      reports: listReports({ ...filter, limit: PAGE_SIZE, offset: offsetFrom(url) }),
    });
    return;
  }

  const apiDetail = path.match(/^\/admin\/api\/reports\/([\w-]+)$/);
  if (apiDetail) {
    const report = getReport(apiDetail[1]);
    if (!report) throw new HttpError(404, "not_found", "No such report");
    sendJson(res, 200, { ...report, payload: JSON.parse(report.payload) });
    return;
  }

  const detail = path.match(/^\/admin(?:\/plain)?\/reports\/([\w-]+)$/);
  if (detail) {
    const report = getReport(detail[1]);
    if (!report) throw new HttpError(404, "not_found", "No such report");
    markRead(report.id, new Date().toISOString());
    sendHtml(res, 200, detailPage(report, actor, plainBase(path)));
    return;
  }

  if (path === "/admin" || path === "/admin/plain") {
    const filter = filterFrom(url);
    const offset = offsetFrom(url);
    const rows = listReports({ ...filter, limit: PAGE_SIZE, offset });
    sendHtml(res, 200, listPage(rows, countReports(filter), url, offset, actor, plainBase(path)));
    return;
  }

  throw new HttpError(404, "not_found", "No such page");
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  config: Config,
  actor: Actor,
): Promise<void> {
  // The HTML pages post to /admin/reports/…, everything else to
  // /admin/api/reports/…. Same actions, so one route answers both.
  const action = path.match(/^\/admin(?:\/api)?\/reports\/([\w-]+)\/(read|retriage)$/);
  if (action) {
    const [, id, verb] = action;
    if (!getReport(id)) throw new HttpError(404, "not_found", "No such report");

    if (verb === "read") markRead(id, new Date().toISOString());
    if (verb === "retriage") resetTriage(id);

    if (path.startsWith("/admin/api/")) {
      sendJson(res, 200, { id, [verb]: true });
      return;
    }

    res.writeHead(303, { location: `/admin/reports/${id}` });
    res.end();
    return;
  }

  // Setting a status takes a form post from the detail page and a JSON body
  // from anything else, so it accepts both rather than having two routes.
  const decide = path.match(/^\/admin(?:\/api)?\/reports\/([\w-]+)\/status$/);
  if (decide) {
    const id = decide[1];
    if (!getReport(id)) throw new HttpError(404, "not_found", "No such report");

    const raw = (await readBody(req, 16 * 1024)).toString("utf8");
    const contentType = header(req, "content-type") ?? "";
    const fields = contentType.includes("application/json")
      ? (JSON.parse(raw || "{}") as { status?: string; note?: string })
      : Object.fromEntries(new URLSearchParams(raw));

    if (!isReportStatus(fields.status)) {
      throw new HttpError(
        400,
        "invalid_status",
        `status must be one of ${REPORT_STATUSES.join(", ")}`,
      );
    }

    const note = fields.note?.toString().trim().slice(0, 500) || null;
    setStatus(id, fields.status, note, new Date().toISOString());

    if (path.startsWith("/admin/api/")) {
      sendJson(res, 200, { id, status: fields.status, note });
      return;
    }

    res.writeHead(303, { location: `/admin/reports/${id}` });
    res.end();
    return;
  }

  if (path === "/admin/people" || path === "/admin/api/people") {
    const raw = (await readBody(req, 16 * 1024)).toString("utf8");
    const fields = (header(req, "content-type") ?? "").includes("application/json")
      ? (JSON.parse(raw || "{}") as { identifier?: string; note?: string })
      : (Object.fromEntries(new URLSearchParams(raw)) as {
          identifier?: string;
          note?: string;
        });

    const identifier = fields.identifier?.trim().slice(0, 200);
    if (!identifier) {
      throw new HttpError(
        400,
        "invalid_person",
        "identifier is required: a Keycloak user id, username or email",
      );
    }

    addAdmin({
      id: `adm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      identifier,
      note: fields.note?.trim().slice(0, 200) || null,
      addedAt: new Date().toISOString(),
      addedBy: actor.kind === "person" ? actor.name : "the admin token",
    });

    if (path.startsWith("/admin/api/")) {
      sendJson(res, 201, { identifier });
      return;
    }

    res.writeHead(303, { location: "/admin/people" });
    res.end();
    return;
  }

  const drop = path.match(/^\/admin(?:\/api)?\/people\/([\w-]+)\/(?:remove|delete)$/);
  if (drop) {
    // Refusing the last one is not politeness. The list is what admits people,
    // so emptying it locks everybody out of the page that could fix it.
    if (countAdmins() <= 1) {
      throw new HttpError(
        409,
        "last_admin",
        "That is the only person with access. Add somebody else first.",
      );
    }

    removeAdmin(drop[1]);

    if (path.startsWith("/admin/api/")) {
      sendJson(res, 200, { ok: true });
      return;
    }

    res.writeHead(303, { location: "/admin/people" });
    res.end();
    return;
  }

  if (path === "/admin/api/bans") {
    const body = JSON.parse(
      (await readBody(req, 16 * 1024)).toString("utf8") || "{}",
    ) as {
      kind?: string;
      value?: string;
      reason?: string;
      expiresAt?: string;
    };

    const kinds: BanKind[] = ["ip", "install", "subject", "app"];
    if (!body.kind || !kinds.includes(body.kind as BanKind) || !body.value) {
      throw new HttpError(400, "invalid_ban", `kind must be one of ${kinds.join(", ")}`);
    }

    const ban = {
      id: `ban_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      kind: body.kind as BanKind,
      value: body.value,
      reason: body.reason ?? null,
      created_at: new Date().toISOString(),
      expires_at: body.expiresAt ?? null,
    };
    addBan(ban);
    sendJson(res, 201, ban);
    return;
  }

  const unban = path.match(/^\/admin\/api\/bans\/([\w-]+)\/delete$/);
  if (unban) {
    removeBan(unban[1]);
    sendJson(res, 200, { ok: true });
    return;
  }

  void config;
  throw new HttpError(404, "not_found", "No such action");
}

/** Opening a report is what marks it read, dashboard or plain page alike. */
function markReadFor(path: string): void {
  const match = path.match(/^\/admin\/reports\/([\w-]+)$/);
  if (match && getReport(match[1])) {
    markRead(match[1], new Date().toISOString());
  }
}

function cookie(req: IncomingMessage, want: string): string | null {
  const cookies = header(req, "cookie") ?? "";
  for (const pair of cookies.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (name === want) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function authorise(
  req: IncomingMessage,
  config: Config,
  oidc: OidcConfig | null,
): Actor | null {
  const auth = header(req, "authorization");
  if (config.adminToken && auth?.startsWith("Bearer ")) {
    return tokenMatches(auth.slice(7).trim(), config.adminToken) ? { kind: "token" } : null;
  }

  if (oidc) {
    const raw = cookie(req, SESSION_COOKIE);
    if (raw) {
      const session = readSession(oidc, raw, Date.now());
      // Checked against the list on every request rather than trusted for the
      // life of the cookie, so removing somebody takes effect immediately
      // instead of whenever their session happens to expire.
      if (session && findAdmin(session.subject, session.name, null)) {
        return { kind: "person", subject: session.subject, name: session.name };
      }
    }
    return null;
  }

  const raw = cookie(req, COOKIE);
  if (raw && config.adminToken && tokenMatches(raw, config.adminToken)) {
    return { kind: "token" };
  }

  return null;
}

/** Send somebody off to sign in, remembering what to check when they return. */
async function sendToKeycloak(res: ServerResponse, oidc: OidcConfig): Promise<void> {
  const { url, state, verifier } = await startLogin(oidc);

  // SameSite=Lax rather than Strict: this cookie has to survive the trip back
  // from Keycloak, which is a cross-site navigation, and Strict would drop it.
  res.writeHead(302, {
    "set-cookie":
      `${LOGIN_COOKIE}=${encodeURIComponent(`${state}.${verifier}`)}; ` +
      "HttpOnly; SameSite=Lax; Path=/admin; Max-Age=600",
    location: url,
  });
  res.end();
}

async function returnFromKeycloak(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  oidc: OidcConfig,
): Promise<void> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const pending = cookie(req, LOGIN_COOKIE);

  if (!code || !state || !pending) {
    throw new HttpError(400, "bad_login", "That sign-in did not come from here");
  }

  const [expectedState, verifier] = pending.split(".");
  if (!expectedState || expectedState !== state) {
    throw new HttpError(400, "bad_login", "That sign-in did not come from here");
  }

  const person = await completeLogin(oidc, code, verifier);
  const entry = admit(oidc, person);

  const clearLogin = `${LOGIN_COOKIE}=; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=0`;

  if (!entry) {
    res.writeHead(403, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": clearLogin,
    });
    res.end(
      page(
        "No access",
        `<h1>No access</h1>
         <p>You are signed in as ${esc(person.name)}, and that account is not on
         the list for this inbox.</p>
         <p class="muted">Somebody already on it can add you. Your user id is
         <code>${esc(person.subject)}</code>.</p>`,
      ),
    );
    return;
  }

  touchAdmin(entry.id, person.subject, person.name, new Date().toISOString());

  const secure = oidc.redirectUri.startsWith("https://") ? " Secure;" : "";
  res.writeHead(303, {
    "set-cookie": [
      clearLogin,
      `${SESSION_COOKIE}=${encodeURIComponent(signSession(oidc, person, Date.now()))}; ` +
        `HttpOnly;${secure} SameSite=Lax; Path=/admin; Max-Age=${oidc.sessionMaxAgeSec}`,
    ],
    location: "/admin",
  });
  res.end();
}

/**
 * The list decides, with one exception: the first person in.
 *
 * An empty list would otherwise lock everyone out of the thing that manages it.
 * The bootstrap name only applies while the list is empty, so removing somebody
 * later does not quietly let them back in through the same door.
 */
function admit(oidc: OidcConfig, person: Person): AdminRow | null {
  const existing = findAdmin(person.subject, person.name, person.email);
  if (existing) return existing;

  if (countAdmins() > 0 || !oidc.bootstrap) return null;

  const wanted = oidc.bootstrap.toLowerCase();
  const matches =
    wanted === person.subject.toLowerCase() ||
    wanted === person.name.toLowerCase() ||
    wanted === (person.email ?? "").toLowerCase();

  if (!matches) return null;

  addAdmin({
    id: `adm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    identifier: person.subject,
    note: "first in, from REPORTS_BOOTSTRAP_ADMIN",
    addedAt: new Date().toISOString(),
    addedBy: null,
  });

  return findAdmin(person.subject, person.name, person.email);
}

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function filterFrom(url: URL) {
  const type = url.searchParams.get("type");
  const verdict = url.searchParams.get("verdict");
  const status = url.searchParams.get("status");
  const triage = url.searchParams.get("triage");
  const shelf = url.searchParams.get("shelf");

  return {
    type: type === "bug" || type === "feedback" ? (type as ReportType) : undefined,
    verdict: verdict || undefined,
    status: isReportStatus(status) ? status : undefined,
    triageStatus:
      triage === "pending" || triage === "done" || triage === "error"
        ? (triage as TriageStatus)
        : undefined,
    shelf:
      shelf === "closed" || shelf === "all" ? (shelf as "closed" | "all") : ("open" as const),
    unreadOnly: url.searchParams.get("unread") === "1",
    search: url.searchParams.get("q") || undefined,
  };
}

function offsetFrom(url: URL): number {
  const page = Number(url.searchParams.get("page") || "1");
  return Number.isFinite(page) && page > 1 ? (Math.floor(page) - 1) * PAGE_SIZE : 0;
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0 auto; max-width: 60rem; padding: 2rem 1rem 6rem; }
  a { color: inherit; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .muted { opacity: .6; }
  .who { font-size: .8rem; margin: 0 0 1rem; }
  .filters { display: flex; flex-wrap: wrap; gap: .5rem; margin: 1rem 0; }
  .filters a { border: 1px solid currentColor; border-radius: 999px; font-size: .8rem; opacity: .7; padding: .15rem .7rem; text-decoration: none; }
  ul.reports { list-style: none; margin: 0; padding: 0; }
  ul.reports li { border-top: 1px solid rgba(128,128,128,.3); padding: .8rem 0; }
  ul.reports a { display: block; text-decoration: none; }
  .row { display: flex; gap: .5rem; align-items: baseline; flex-wrap: wrap; }
  .tag { border-radius: .3rem; font-size: .72rem; padding: .1rem .45rem; background: rgba(128,128,128,.18); }
  .tag.bug { background: rgba(217,83,79,.22); }
  .tag.high { background: rgba(217,83,79,.3); }
  .tag.noise { opacity: .55; }
  .unread { font-weight: 600; }
  pre { background: rgba(128,128,128,.12); border-radius: .4rem; overflow-x: auto; padding: .8rem; white-space: pre-wrap; word-break: break-word; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border-bottom: 1px solid rgba(128,128,128,.25); padding: .3rem .5rem; text-align: left; vertical-align: top; }
  form { display: inline; }
  button { font: inherit; padding: .3rem .8rem; }
  form.decide { display: flex; flex-wrap: wrap; gap: .4rem; margin: 1rem 0; }
  form.decide input { flex: 1 1 16rem; font: inherit; padding: .3rem .5rem; }
`;

/** Who you are and how to stop being them, on every page that has an actor. */
function whoami(actor: Actor): string {
  if (actor.kind === "token") {
    return '<p class="muted who">signed in with the admin token</p>';
  }
  return `<p class="muted who">${esc(actor.name)} · <a href="/admin/people">people</a> · <a href="/admin/logout">sign out</a></p>`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body>${body}</body></html>`;
}

/**
 * Which of the two plain surfaces this request came in by.
 *
 * `/admin/plain` is the fallback for a broken dashboard build, so its links
 * have to stay inside it. When the dashboard is not built at all these same
 * pages answer at `/admin`, and then the links belong there.
 */
function plainBase(path: string): string {
  return path.startsWith("/admin/plain") ? "/admin/plain" : "/admin";
}

function listPage(
  rows: ReportSummary[],
  total: number,
  url: URL,
  offset: number,
  actor: Actor,
  base: string,
): string {
  const s = stats();
  const links = [
    ["Open", ""],
    ["Unread", "unread=1"],
    ["Bugs", "type=bug"],
    ["Feedback", "type=feedback"],
    ["Actionable", "verdict=actionable"],
    ["Needs info", "verdict=needs_info"],
    ["Noise", "verdict=noise"],
    ["Untriaged", "triage=pending"],
    ["Resolved", "status=resolved"],
    ["Won't do", "status=wont_do"],
    ["Closed", "shelf=closed"],
    ["Everything", "shelf=all"],
  ]
    .map(([label, query]) => `<a href="${base}${query ? `?${query}` : ""}">${esc(label)}</a>`)
    .join("");

  const items = rows.length
    ? rows
        .map((r) => {
          const when = new Date(r.received_at).toISOString().replace("T", " ").slice(0, 16);
          const tags = [
            `<span class="tag ${r.type}">${esc(r.type)}</span>`,
            r.status === "new" ? "" : `<span class="tag">${esc(statusLabel(r.status))}</span>`,
            r.triage_priority
              ? `<span class="tag ${esc(r.triage_priority)}">${esc(r.triage_priority)}</span>`
              : "",
            r.triage_verdict
              ? `<span class="tag ${esc(r.triage_verdict)}">${esc(r.triage_verdict)}</span>`
              : '<span class="tag muted">untriaged</span>',
            r.triage_area ? `<span class="tag">${esc(r.triage_area)}</span>` : "",
          ].join(" ");

          const headline = r.triage_summary ?? r.title ?? r.message.slice(0, 120);

          return `<li><a href="${base}/reports/${esc(r.id)}">
            <div class="row">${tags}<span class="muted">${esc(when)}</span></div>
            <div class="${r.read_at ? "" : "unread"}">${esc(headline)}</div>
            <div class="muted">${esc(r.app_id)} ${esc(r.app_version ?? "?")} · ${esc(
              [r.platform, r.os_version, r.device_model].filter(Boolean).join(" ") || "unknown device",
            )}</div>
          </a></li>`;
        })
        .join("")
    : '<li class="muted">Nothing here.</li>';

  const pageNo = Math.floor(offset / PAGE_SIZE) + 1;
  const pages: string[] = [];
  if (offset > 0) pages.push(`<a href="${esc(pageLink(url, pageNo - 1))}">← newer</a>`);
  if (offset + PAGE_SIZE < total) {
    pages.push(`<a href="${esc(pageLink(url, pageNo + 1))}">older →</a>`);
  }

  return page(
    "Gryt reports",
    `${whoami(actor)}
     <h1>Gryt reports</h1>
     <p class="muted">${s.open} open · ${s.unread} unread · ${s.pending} waiting on triage · ${s.total} in total · ${s.bugs} bugs · ${s.feedback} feedback</p>
     <div class="filters">${links}</div>
     <ul class="reports">${items}</ul>
     <p>${pages.join(" · ")}</p>`,
  );
}

function pageLink(url: URL, page: number): string {
  const next = new URL(url.toString());
  next.searchParams.set("page", String(page));
  return `${next.pathname}?${next.searchParams.toString()}`;
}

function peoplePage(people: AdminRow[], actor: Actor, oidc: OidcConfig | null): string {
  const rows = people.length
    ? people
        .map(
          (person) => `<tr>
            <td>${esc(person.name ?? person.identifier)}${
              person.name && person.name !== person.identifier
                ? `<br /><span class="muted">${esc(person.identifier)}</span>`
                : ""
            }</td>
            <td class="muted">${esc(person.note ?? "")}</td>
            <td class="muted">${esc(
              person.last_seen_at ? person.last_seen_at.slice(0, 10) : "never signed in",
            )}</td>
            <td><form method="post" action="/admin/people/${esc(person.id)}/remove">
              <button type="submit">Remove</button>
            </form></td>
          </tr>`,
        )
        .join("")
    : '<tr><td colspan="4" class="muted">Nobody yet.</td></tr>';

  return page(
    "Who can read this",
    `${whoami(actor)}
     <p><a href="/admin">← inbox</a></p>
     <h1>Who can read this</h1>
     <p class="muted">${
       oidc
         ? "Everyone here signs in with their Gryt account. Anyone else gets turned away, whether or not they have one."
         : "Sign-in is not configured, so this list does nothing and the admin token is what guards the inbox."
     }</p>
     <table>
       <tr><th>Who</th><th>Note</th><th>Last seen</th><th></th></tr>
       ${rows}
     </table>
     <h2>Add somebody</h2>
     <form method="post" action="/admin/people" class="decide">
       <input type="text" name="identifier" maxlength="200" required
              placeholder="Keycloak user id, username or email" />
       <input type="text" name="note" maxlength="200" placeholder="who they are" />
       <button type="submit">Add</button>
     </form>
     <p class="muted">A username or email works before they have ever signed in.
     The first time they do, this pins to their user id, which is the one thing
     about an account nobody can change.</p>`,
  );
}

const STATUS_LABELS: Record<ReportStatus, string> = {
  new: "new",
  open: "open",
  resolved: "resolved",
  wont_do: "won't do",
  duplicate: "duplicate",
};

function statusLabel(status: ReportStatus): string {
  return STATUS_LABELS[status] ?? status;
}

function detailPage(r: ReportRow, actor: Actor, base: string): string {
  const payload = JSON.parse(r.payload) as Record<string, unknown>;

  const facts: [string, string | null][] = [
    ["Status", `${statusLabel(r.status)}${r.status_note ? ` — ${r.status_note}` : ""}`],
    ["Decided", r.status_at],
    ["Received", r.received_at],
    ["Type", r.type],
    ["App", `${r.app_id} ${r.app_version ?? "?"}`],
    ["Build", r.app_build],
    ["Channel", r.app_channel],
    ["Commit", r.app_commit],
    ["Platform", [r.platform, r.os_version, r.device_model].filter(Boolean).join(" ") || null],
    ["Install", r.install_id],
    ["Identity", r.identity_subject],
    ["IP", r.ip],
    ["Contact", r.contact],
    ["Triage", r.triage_status === "done" ? `${r.triage_verdict} · ${r.triage_priority} · ${r.triage_area}` : r.triage_status],
    ["Duplicate of", r.triage_duplicate_of],
    ["Why", r.triage_reasoning],
    ["Model", r.triage_model],
    ["Triage error", r.triage_error],
  ];

  const table = facts
    .filter(([, value]) => value)
    .map(([label, value]) => `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`)
    .join("");

  const bans = (["ip", "install", "subject"] as const)
    .map((kind) => {
      const value = kind === "ip" ? r.ip : kind === "install" ? r.install_id : r.identity_subject;
      if (!value) return "";
      return `<code>${esc(kind)}:${esc(value)}</code>`;
    })
    .filter(Boolean)
    .join(" ");

  return page(
    r.triage_summary ?? r.id,
    `${whoami(actor)}
     <p><a href="/admin">← inbox</a></p>
     <h1>${esc(r.triage_summary ?? r.title ?? `${r.type} report`)}</h1>
     <p class="muted">${esc(r.id)}</p>
     <pre>${esc(r.message)}</pre>
     <table>${table}</table>
     <form method="post" action="${base}/reports/${esc(r.id)}/status" class="decide">
       <input type="text" name="note" maxlength="500" placeholder="why, or the task it became"
              value="${esc(r.status_note ?? "")}" />
       ${REPORT_STATUSES.filter((status) => status !== r.status)
         .map(
           (status) =>
             `<button type="submit" name="status" value="${status}">${esc(statusLabel(status))}</button>`,
         )
         .join("")}
     </form>
     <p>
       <form method="post" action="${base}/reports/${esc(r.id)}/retriage">
         <button type="submit">Triage again</button>
       </form>
     </p>
     ${bans ? `<p class="muted">Bannable: ${bans} — POST /admin/api/bans</p>` : ""}
     <h2>Everything the app sent</h2>
     <pre>${esc(JSON.stringify(payload, null, 2))}</pre>`,
  );
}
