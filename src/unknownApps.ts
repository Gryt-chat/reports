import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { checkAppKey } from "./auth.ts";
import type { Config } from "./config.ts";
import { listUnknownApps, pruneUnknownApps, recordUnknownApps } from "./db.ts";
import { clientIp, header, HttpError, readBody, sendJson } from "./http.ts";

/** Per request: the desktop app sends what it saw that day, which is rarely more than a few. */
const MAX_IDS_PER_REQUEST = 20;
const MAX_LISTED = 500;
const LISTED_FOR_MS = 30 * 24 * 60 * 60 * 1000;
const PER_HOUR = 12;

/** Snowflake-shaped ids only, deduplicated. Anything else in the list is dropped, not refused. */
export function cleanIds(value: unknown): string[] {
  const list = (value as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(list)) throw new HttpError(400, "invalid_body", "Expected { ids: [...] }");
  const ids = [...new Set(list.filter((id): id is string => typeof id === "string" && /^\d{17,20}$/.test(id)))];
  return ids.slice(0, MAX_IDS_PER_REQUEST);
}

/* In memory on purpose: the address decides the limit and is never written down. */
const recent = new Map<string, number[]>();

export function withinLimit(key: string, now: number, perHour = PER_HOUR): boolean {
  const since = now - 60 * 60 * 1000;
  const times = (recent.get(key) ?? []).filter((t) => t >= since);
  if (times.length >= perHour) {
    recent.set(key, times);
    return false;
  }
  times.push(now);
  recent.set(key, times);
  if (recent.size > 50_000) recent.clear();
  return true;
}

export async function takeUnknownApps(req: IncomingMessage, res: ServerResponse, config: Config): Promise<void> {
  checkAppKey(header(req, "x-gryt-app"), header(req, "x-gryt-app-key"), config.appKeys, config.allowUnkeyed);
  const ip = clientIp(req, config.trustProxy, config.trustedProxies, () => {});
  if (!withinLimit(ip ?? "unknown", Date.now())) throw new HttpError(429, "rate_limited", "Too many", { retryAfter: 3600 });
  const raw = await readBody(req, 4096);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Body is not valid JSON");
  }
  const ids = cleanIds(parsed);
  if (ids.length) recordUnknownApps(ids, new Date().toISOString());
  sendJson(res, 202, { accepted: ids.length });
}

/** A rarely seen id can point at one person, so the list is for the game list's job only. */
export function mayReadUnknownApps(authorization: string | null, token: string | null): boolean {
  if (!token || !authorization?.startsWith("Bearer ")) return false;
  const given = Buffer.from(authorization.slice(7));
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export function giveUnknownApps(req: IncomingMessage, res: ServerResponse, config: Config, now = Date.now()): void {
  if (!mayReadUnknownApps(header(req, "authorization"), config.unknownAppsToken)) {
    throw new HttpError(404, "not_found", "No such endpoint");
  }
  pruneUnknownApps(new Date(now - LISTED_FOR_MS).toISOString());
  sendJson(res, 200, { ids: listUnknownApps(new Date(now - LISTED_FOR_MS).toISOString(), MAX_LISTED) });
}
