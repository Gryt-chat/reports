import {
  type BanRow,
  countRateEvents,
  findBan,
  pruneRateEvents,
  recordRateEvent,
} from "./db.ts";
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
  minIntervalSec: number;
  perMinute: number;
  perHourPerIp: number;
  perHourPerInstall: number;
  perDayPerIp: number;
}

/**
 * The ban covering this submitter, if there is one.
 *
 * Four kinds, because the useful one depends on what you know. An IP is what
 * you always have and the weakest — it moves. An install id is stable until
 * someone reinstalls. A key thumbprint costs a new identity to shed, which is
 * the closest thing here to banning a person. An app id is the blunt one: it
 * turns off a whole client, and exists for the day a key leaks and the endpoint
 * is being hammered through it.
 *
 * Returns rather than throws, because a banned submitter is not told. See
 * `ingest`.
 */
export function banFor(who: Submitter, nowIso: string): BanRow | null {
  const targets: [Parameters<typeof findBan>[0], string | null][] = [
    ["ip", who.ip],
    ["install", who.installId],
    ["subject", who.subject],
    ["app", who.appId],
  ];

  for (const [kind, value] of targets) {
    if (!value) continue;
    const ban = findBan(kind, value, nowIso);
    if (ban) return ban;
  }

  return null;
}

/**
 * Count an attempt that a ban swallowed.
 *
 * Without this a ban is completely silent in both directions: the person
 * hitting it cannot tell, and neither can you. The inbox reads this back so a
 * ban can say whether it is still absorbing anything, which is the difference
 * between one that worked and one that is now just sitting there.
 *
 * Pruned with the other rate events after a day, so it answers "recently"
 * rather than "ever", which is the more useful question anyway.
 */
export function recordBlocked(who: Submitter, ban: BanRow, now: number): void {
  recordRateEvent(`blocked:${ban.id}`, now);
  // Also against the ordinary buckets, so somebody who is banned and switches
  // networks arrives having already spent part of their new address's budget.
  recordSubmission(who, now);
}

/** How many attempts this ban has swallowed in the last day. */
export function blockedCount(banId: string, now: number): number {
  return countRateEvents(`blocked:${banId}`, now - DAY);
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
  const list: Window[] = [];

  // First in the list, so a script in a loop trips this one rather than an
  // hourly counter — the answer it gets back is ten seconds, which is true and
  // is the one a person filing a second report can act on. Applied to every
  // identifier rather than only the address, or rotating networks would shed
  // it along with everything else.
  if (limits.minIntervalSec > 0) {
    const gap = limits.minIntervalSec * 1000;
    for (const bucket of bucketsFor(who)) {
      list.push({ bucket, windowMs: gap, max: 1 });
    }
  }

  list.push(
    { bucket: `ip:${who.ip}`, windowMs: MINUTE, max: limits.perMinute },
    { bucket: `ip:${who.ip}`, windowMs: HOUR, max: limits.perHourPerIp },
    { bucket: `ip:${who.ip}`, windowMs: DAY, max: limits.perDayPerIp },
  );

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
