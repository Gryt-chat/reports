import { countRateEvents, findBan, pruneRateEvents, recordRateEvent } from "./db.ts";
import { HttpError } from "./http.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface Submitter {
  ip: string;
  appId: string;
  installId: string | null;
  subject: string | null;
}

export interface LimitConfig {
  perMinute: number;
  perHourPerIp: number;
  perHourPerInstall: number;
  perDayPerIp: number;
}

/**
 * Refuse a submitter who is banned.
 *
 * Four kinds, because the useful one depends on what you know. An IP is what
 * you always have and the weakest — it moves. An install id is stable until
 * someone reinstalls. A key thumbprint costs a new identity to shed, which is
 * the closest thing here to banning a person. An app id is the blunt one: it
 * turns off a whole client, and exists for the day a key leaks and the endpoint
 * is being hammered through it.
 */
export function assertNotBanned(who: Submitter, nowIso: string): void {
  const targets: [Parameters<typeof findBan>[0], string | null][] = [
    ["ip", who.ip],
    ["install", who.installId],
    ["subject", who.subject],
    ["app", who.appId],
  ];

  for (const [kind, value] of targets) {
    if (!value) continue;
    const ban = findBan(kind, value, nowIso);
    if (ban) {
      // The reason is deliberately not returned. Someone working out which of
      // their identifiers is banned is someone working out which one to change.
      throw new HttpError(403, "banned", "This client may not submit reports");
    }
  }
}

interface Window {
  bucket: string;
  windowMs: number;
  max: number;
}

/** Every counter one submission belongs to. */
function bucketsFor(who: Submitter): string[] {
  const buckets = [`ip:${who.ip}`];
  if (who.installId) buckets.push(`install:${who.installId}`);
  if (who.subject) buckets.push(`subject:${who.subject}`);
  return buckets;
}

function windows(who: Submitter, limits: LimitConfig): Window[] {
  const list: Window[] = [
    { bucket: `ip:${who.ip}`, windowMs: MINUTE, max: limits.perMinute },
    { bucket: `ip:${who.ip}`, windowMs: HOUR, max: limits.perHourPerIp },
    { bucket: `ip:${who.ip}`, windowMs: DAY, max: limits.perDayPerIp },
  ];

  if (who.installId) {
    list.push({
      bucket: `install:${who.installId}`,
      windowMs: HOUR,
      max: limits.perHourPerInstall,
    });
  }

  if (who.subject) {
    list.push({
      bucket: `subject:${who.subject}`,
      windowMs: HOUR,
      max: limits.perHourPerInstall,
    });
  }

  return list;
}

/**
 * Throw if any window is full.
 *
 * Counted in SQLite rather than in memory, so restarting the service is not a
 * way to clear your limit.
 */
export function assertWithinLimits(
  who: Submitter,
  limits: LimitConfig,
  now: number,
): void {
  for (const window of windows(who, limits)) {
    const used = countRateEvents(window.bucket, now - window.windowMs);
    if (used >= window.max) {
      const retryAfter = Math.ceil(window.windowMs / 1000);
      throw new HttpError(
        429,
        "rate_limited",
        "Too many reports from this client. Try again later.",
        { retryAfter },
      );
    }
  }
}

/** Count an accepted report against every bucket it belongs to. */
export function recordSubmission(who: Submitter, now: number): void {
  for (const bucket of bucketsFor(who)) {
    recordRateEvent(bucket, now);
  }
}

/** Drop counters nothing can still be counting against. */
export function pruneOldEvents(now: number): void {
  pruneRateEvents(now - DAY);
}
