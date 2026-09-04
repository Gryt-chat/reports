import consola from "consola";

import type { Config } from "./config.ts";
import { scrubReportIdentifiers } from "./db.ts";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Forget who sent a report, once knowing is no longer any use.
 *
 * The address and thumbprint exist for one reason: the noise auto-ban counts a
 * submitter's junk against them, over `autoBan.windowHours`. **Nothing reads
 * either column beyond that window**, so the retention default is two days
 * rather than a month.
 *
 * `install_id` and `user_agent` stay. An install id is meaningless outside this
 * database and is what shows that a crash report and last week's crash report
 * came from the same copy of the app. A user-agent is the app version and the
 * OS, both of which the row already carries in their own columns.
 *
 * The report itself stays whole. What somebody wrote is the part with value,
 * and it is still readable, still filed as a task, still countable.
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
