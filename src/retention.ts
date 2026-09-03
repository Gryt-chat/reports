import consola from "consola";

import type { Config } from "./config.ts";
import { scrubReportIdentifiers } from "./db.ts";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Forget who sent a report, once knowing is no longer any use.
 *
 * The address, the install id and the user-agent are on a report so that one
 * person cannot flood the inbox. Every mechanism that uses them works over
 * hours or days: the rate windows are a minute, an hour and a day, the noise
 * counter looks back `autoBan.windowHours`, and a ban that comes out of it
 * copies the value into `bans` with its own expiry. None of them reads a row
 * this old.
 *
 * The report itself stays. What somebody wrote is the part with value, and it
 * is still readable, still filed as a task, still countable. What goes is the
 * part that says which house it came from.
 *
 * `identity_subject` stays too, and that is a deliberate exception. It is the
 * account, not the network — we already hold it in Keycloak — and it is the
 * only way to answer somebody who asks us to delete the report they sent.
 * Scrubbing it would make the promise in the privacy policy unkeepable, which
 * is a worse outcome than keeping a pseudonymous id.
 */
export function scrubOldIdentifiers(config: Config, now: number): number {
  const days = config.retention.identifierDays;
  if (days <= 0) return 0;

  const before = new Date(now - days * DAY).toISOString();
  const scrubbed = scrubReportIdentifiers(before);

  if (scrubbed > 0) {
    consola.info(
      `[reports] Forgot the sender of ${scrubbed} report(s) older than ${days} days`,
    );
  }
  return scrubbed;
}
