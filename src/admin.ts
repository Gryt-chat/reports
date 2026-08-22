import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Config } from "./config.ts";
import {
  addBan,
  countReports,
  getReport,
  listBans,
  listReports,
  markRead,
  removeBan,
  resetTriage,
  setArchived,
  stats,
  type BanKind,
  type ReportRow,
  type ReportType,
  type TriageStatus,
} from "./db.ts";
import { esc, header, HttpError, readBody, sendHtml, sendJson } from "./http.ts";

const COOKIE = "gryt_reports_admin";
const PAGE_SIZE = 50;

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
): Promise<void> {
  if (!config.adminToken) {
    throw new HttpError(404, "not_found", "No admin token configured");
  }

  const path = url.pathname.replace(/\/+$/, "") || "/admin";

  // Signing in is one link with the token on it. It is swapped for a cookie
  // immediately so it stops turning up in browser history and referrers.
  const queryToken = url.searchParams.get("token");
  if (queryToken) {
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

  if (!authorised(req, config.adminToken)) {
    throw new HttpError(401, "unauthorised", "Admin token required");
  }

  if (req.method === "POST") {
    await handlePost(req, res, path, config);
    return;
  }

  if (req.method !== "GET") {
    throw new HttpError(405, "method_not_allowed", "GET or POST");
  }

  if (path === "/admin/api/stats") {
    sendJson(res, 200, stats());
    return;
  }

  if (path === "/admin/api/bans") {
    sendJson(res, 200, { bans: listBans() });
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

  const detail = path.match(/^\/admin\/reports\/([\w-]+)$/);
  if (detail) {
    const report = getReport(detail[1]);
    if (!report) throw new HttpError(404, "not_found", "No such report");
    markRead(report.id, new Date().toISOString());
    sendHtml(res, 200, detailPage(report));
    return;
  }

  if (path === "/admin") {
    const filter = filterFrom(url);
    const offset = offsetFrom(url);
    const rows = listReports({ ...filter, limit: PAGE_SIZE, offset });
    sendHtml(res, 200, listPage(rows, countReports(filter), url, offset));
    return;
  }

  throw new HttpError(404, "not_found", "No such page");
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  config: Config,
): Promise<void> {
  const action = path.match(/^\/admin\/reports\/([\w-]+)\/(read|archive|unarchive|retriage)$/);
  if (action) {
    const [, id, verb] = action;
    if (!getReport(id)) throw new HttpError(404, "not_found", "No such report");

    if (verb === "read") markRead(id, new Date().toISOString());
    if (verb === "archive") setArchived(id, new Date().toISOString());
    if (verb === "unarchive") setArchived(id, null);
    if (verb === "retriage") resetTriage(id);

    res.writeHead(303, { location: `/admin/reports/${id}` });
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

function authorised(req: IncomingMessage, expected: string): boolean {
  const auth = header(req, "authorization");
  if (auth?.startsWith("Bearer ")) {
    return tokenMatches(auth.slice(7).trim(), expected);
  }

  const cookies = header(req, "cookie") ?? "";
  for (const pair of cookies.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (name === COOKIE) {
      return tokenMatches(decodeURIComponent(rest.join("=")), expected);
    }
  }

  return false;
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
  const shelf = url.searchParams.get("shelf");

  return {
    type: type === "bug" || type === "feedback" ? (type as ReportType) : undefined,
    verdict: verdict || undefined,
    status:
      status === "pending" || status === "done" || status === "error"
        ? (status as TriageStatus)
        : undefined,
    shelf:
      shelf === "archived" || shelf === "all" ? (shelf as "archived" | "all") : ("inbox" as const),
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
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body>${body}</body></html>`;
}

function listPage(rows: ReportRow[], total: number, url: URL, offset: number): string {
  const s = stats();
  const links = [
    ["Everything", ""],
    ["Unread", "unread=1"],
    ["Bugs", "type=bug"],
    ["Feedback", "type=feedback"],
    ["Actionable", "verdict=actionable"],
    ["Needs info", "verdict=needs_info"],
    ["Noise", "verdict=noise"],
    ["Untriaged", "status=pending"],
    ["Archived", "shelf=archived"],
  ]
    .map(([label, query]) => `<a href="/admin${query ? `?${query}` : ""}">${esc(label)}</a>`)
    .join("");

  const items = rows.length
    ? rows
        .map((r) => {
          const when = new Date(r.received_at).toISOString().replace("T", " ").slice(0, 16);
          const tags = [
            `<span class="tag ${r.type}">${esc(r.type)}</span>`,
            r.triage_priority
              ? `<span class="tag ${esc(r.triage_priority)}">${esc(r.triage_priority)}</span>`
              : "",
            r.triage_verdict
              ? `<span class="tag ${esc(r.triage_verdict)}">${esc(r.triage_verdict)}</span>`
              : '<span class="tag muted">untriaged</span>',
            r.triage_area ? `<span class="tag">${esc(r.triage_area)}</span>` : "",
          ].join(" ");

          const headline = r.triage_summary ?? r.title ?? r.message.slice(0, 120);

          return `<li><a href="/admin/reports/${esc(r.id)}">
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
    `<h1>Gryt reports</h1>
     <p class="muted">${s.total} in total · ${s.unread} unread · ${s.pending} waiting on triage · ${s.bugs} bugs · ${s.feedback} feedback</p>
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

function detailPage(r: ReportRow): string {
  const payload = JSON.parse(r.payload) as Record<string, unknown>;

  const facts: [string, string | null][] = [
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
    `<p><a href="/admin">← inbox</a></p>
     <h1>${esc(r.triage_summary ?? r.title ?? `${r.type} report`)}</h1>
     <p class="muted">${esc(r.id)}</p>
     <pre>${esc(r.message)}</pre>
     <table>${table}</table>
     <p>
       <form method="post" action="/admin/reports/${esc(r.id)}/${r.archived_at ? "unarchive" : "archive"}">
         <button type="submit">${r.archived_at ? "Unarchive" : "Archive"}</button>
       </form>
       <form method="post" action="/admin/reports/${esc(r.id)}/retriage">
         <button type="submit">Triage again</button>
       </form>
     </p>
     ${bans ? `<p class="muted">Bannable: ${bans} — POST /admin/api/bans</p>` : ""}
     <h2>Everything the app sent</h2>
     <pre>${esc(JSON.stringify(payload, null, 2))}</pre>`,
  );
}
