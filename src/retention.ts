import consola from "consola";

import type { Config } from "./config.ts";
import { scrubReportIdentifiers } from "./db.ts";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Forget who sent a report, once knowing is no longer any use: nothing reads the address or
 * thumbprint past the auto-ban window. `install_id` and `user_agent` stay, and so does the text.
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
