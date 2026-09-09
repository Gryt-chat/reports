import consola from "consola";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTransport, type Transporter } from "nodemailer";

import type { Config } from "./config.ts";
import {
  adminEmails,
  countByTypeBetween,
  countReports,
  lastDigestAt,
  recordDigest,
  totalsByApp,
  totalsByType,
} from "./db.ts";
import { MARK_CID, render, type Week } from "./digestMail.ts";

/**
 * A weekly note saying what arrived, because nothing else tells anybody a report exists. A
 * quiet week still sends: otherwise "nothing arrived" and "the digest is broken" look alike.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** `totalsByType` under the names the mail uses, so the spread reads. */
function totalsByTypeNamed(): { totalBug: number; totalFeedback: number } {
  const totals = totalsByType();
  return { totalBug: totals.bug, totalFeedback: totals.feedback };
}

/**
 * The app icon, attached rather than linked: Gmail and Outlook render neither a remote SVG
 * nor, by default, a remote image. Read once at startup, so a missing file says so then.
 */
export function markPng(): Buffer | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "..", "assets", "gryt-mark.png"));
  } catch {
    return null;
  }
}

const MARK = markPng();

/** What arrived in the week, and the standing totals it sits against. */
export function weekFor(now: Date): Week {
  const to = now.toISOString();
  const from = new Date(now.getTime() - WEEK_MS).toISOString();

  const week = countByTypeBetween(from, to);

  return {
    from,
    to,
    bug: week.bug,
    feedback: week.feedback,
    openNow: countReports({ shelf: "open" }),
    ...totalsByTypeNamed(),
    byApp: totalsByApp(),
  };
}

/**
 * Whether this is the moment: the configured hour has come round, and nothing has gone out
 * in six days. Without the second, a restart on the right morning sends a second copy.
 */
export function isDue(config: Config, now: Date, last: string | null): boolean {
  if (!config.digest.enabled) return false;
  if (now.getDay() !== config.digest.day) return false;
  if (now.getHours() < config.digest.hour) return false;
  if (!last) return true;
  return now.getTime() - Date.parse(last) > 6 * 24 * 60 * 60 * 1000;
}

export class Digest {
  private readonly config: Config;
  private timer: NodeJS.Timeout | null = null;
  private transport: Transporter | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  start(): void {
    const { enabled, smtp, day, hour } = this.config.digest;
    if (!enabled) {
      consola.info("[digest] Off. No GRYT_SMTP_HOST, or turned off.");
      return;
    }
    if (!smtp.host) {
      consola.warn("[digest] On, but no SMTP host. Nothing will send.");
      return;
    }

    this.transport = createTransport({
      host: smtp.host,
      port: smtp.port,
      // 465 is implicit TLS; everything else starts plain and upgrades, which
      // is what 587 does and what Postmark expects.
      secure: smtp.port === 465,
      auth: smtp.user && smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined,
    });

    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    consola.info(`[digest] On, ${days[day]}s from ${String(hour).padStart(2, "0")}:00`);
    if (!MARK) consola.warn("[digest] assets/gryt-mark.png is missing — mail will have no mark.");

    // Every fifteen minutes. The check is three integer comparisons and one indexed row, so
    // it does not matter which quarter hour the service happened to start on.
    this.timer = setInterval(() => void this.tick(), 15 * 60 * 1000);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Send now, whatever the day is. What the admin button calls. */
  async sendNow(now = new Date()): Promise<{ sent: number; skipped: number }> {
    return this.send(weekFor(now), now);
  }

  private async tick(): Promise<void> {
    const now = new Date();
    if (!isDue(this.config, now, lastDigestAt())) return;
    try {
      await this.send(weekFor(now), now);
    } catch (err) {
      // Not fatal, and not retried until the next quarter hour. A digest that
      // takes the service down with it would be a worse trade than a late one.
      consola.error("[digest] Send failed", err);
    }
  }

  private async send(week: Week, now: Date): Promise<{ sent: number; skipped: number }> {
    const people = adminEmails();
    if (people.length === 0) {
      consola.warn("[digest] Nobody on the allowlist has a known address.");
      recordDigest(now.toISOString(), week.from, 0);
      return { sent: 0, skipped: 0 };
    }

    const { smtp } = this.config.digest;
    const mail = render(week, this.config.publicUrl);
    let sent = 0;

    for (const person of people) {
      try {
        // One message each rather than one with everybody in it. The allowlist is a list of
        // people who can read the inbox, not a list they agreed to be shown to each other.
        await this.transport?.sendMail({
          from: { name: smtp.fromName, address: smtp.from },
          to: person.email,
          replyTo: smtp.replyTo ?? undefined,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          attachments: MARK
            ? [{ filename: "gryt.png", content: MARK, cid: MARK_CID, contentType: "image/png" }]
            : [],
        });
        sent += 1;
      } catch (err) {
        consola.warn(`[digest] Could not send to one recipient: ${(err as Error).message}`);
      }
    }

    recordDigest(now.toISOString(), week.from, sent);
    consola.info(`[digest] Sent to ${sent} of ${people.length}`);
    return { sent, skipped: people.length - sent };
  }
}

/**
 * A week that never happened, for looking at the design: fixed numbers make this a preview of
 * the template rather than of the data. `?live=1` still renders the real thing.
 */
export function sampleWeek(now = new Date()): Week {
  return {
    from: new Date(now.getTime() - WEEK_MS).toISOString(),
    to: now.toISOString(),
    bug: 23,
    feedback: 9,
    openNow: 46,
    totalBug: 428,
    totalFeedback: 137,
    byApp: [
      { app: "desktop", count: 291 },
      { app: "mobile", count: 194 },
      { app: "web", count: 66 },
      { app: "cli", count: 14 },
    ],
  };
}
