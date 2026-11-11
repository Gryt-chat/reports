import consola from "consola";
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createTransport } from "nodemailer";

import type { Config } from "./config.ts";
import { joinWaitlist, leaveWaitlist } from "./db.ts";
import { clientIp, header, HttpError, isAllowedOrigin, readBody, sendHtml, sendJson } from "./http.ts";
import { withinLimit } from "./unknownApps.ts";

const PER_HOUR_PER_IP = 5;

export type Mail = { to: string; subject: string; text: string };
export type SendMail = (mail: Mail) => Promise<void>;

export function cleanEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>".]{2,}$/.test(email)) return null;
  return email;
}

const PLANS = new Set(["friends", "community", "large"]);

export const cleanPlan = (value: unknown): string | null =>
  typeof value === "string" && PLANS.has(value) ? value : null;

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export function welcomeMail(to: string, leaveUrl: string): Mail {
  return {
    to,
    subject: "You're on the Gryt Cloud list",
    text: [
      "You're on the list!",
      "",
      "You'll be the first to know when Gryt Cloud is live: your own Gryt server, always online, run by us.",
      "And because you signed up early, you get 50% off your first year.",
      "",
      "That's the only email you'll get until it opens.",
      "",
      `Didn't sign up, or changed your mind? Leave the list: ${leaveUrl}`,
      "",
      "Sivert, Gryt",
    ].join("\n"),
  };
}

export function smtpSender(config: Config): SendMail | null {
  const smtp = config.digest.smtp;
  if (!smtp.host) return null;
  const transport = createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.user && smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  return async (mail) => {
    await transport.sendMail({ from: { name: smtp.fromName, address: smtp.from }, replyTo: smtp.replyTo ?? undefined, ...mail });
  };
}

/** Always the same answer, joined or not, so the form can't be used to test who is on the list. */
export async function join(req: IncomingMessage, res: ServerResponse, config: Config, send: SendMail | null): Promise<void> {
  if (!send || !config.publicUrl) throw new HttpError(503, "waitlist_off", "The waitlist isn't open");
  const origin = header(req, "origin");
  if (!origin || !isAllowedOrigin(origin, config.corsOrigins)) {
    throw new HttpError(403, "origin_not_allowed", "Sign up from gryt.chat");
  }
  const ip = clientIp(req, config.trustProxy, config.trustedProxies, () => {});
  if (!withinLimit(`waitlist:${ip}`, Date.now(), PER_HOUR_PER_IP)) {
    throw new HttpError(429, "rate_limited", "Too many", { retryAfter: 3600 });
  }

  let body: { email?: unknown; news?: unknown; plan?: unknown };
  try {
    body = JSON.parse((await readBody(req, 2048)).toString("utf8")) as typeof body;
  } catch {
    throw new HttpError(400, "invalid_json", "Body is not valid JSON");
  }
  const email = cleanEmail(body?.email);
  if (!email) throw new HttpError(400, "invalid_email", "That doesn't look like an email address");

  const token = randomBytes(24).toString("base64url");
  const added = joinWaitlist(email, body.news === true, cleanPlan(body.plan), hashToken(token), new Date().toISOString());
  sendJson(res, 202, { ok: true });
  if (!added) return;

  try {
    await send(welcomeMail(email, `${config.publicUrl}/v1/waitlist/leave?t=${token}`));
  } catch (err) {
    consola.warn("[waitlist] welcome mail failed", err);
  }
}

const page = (body: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Gryt Cloud</title>` +
  `<body style="font:16px/1.6 system-ui,sans-serif;background:#111318;color:#e0e0e6;max-width:32rem;margin:15vh auto;padding:0 16px">${body}</body>`;

/* GET only shows a button: mail scanners open every link, and a GET that deleted would take people off the list. */
export async function leave(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const token = url.searchParams.get("t") ?? "";
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HttpError(404, "not_found", "No such link");

  if (req.method === "POST") {
    leaveWaitlist(hashToken(token));
    sendHtml(res, 200, page("<h1>You're off the list</h1><p>You won't hear from us about Gryt Cloud.</p>"));
    return;
  }
  sendHtml(
    res,
    200,
    page(
      `<h1>Leave the Gryt Cloud list?</h1><p>You won't get the email when it opens, or the discount.</p>` +
        `<form method="post"><button style="font:inherit;padding:10px 20px;border-radius:999px;border:0;background:#968ff8;color:#14161d;font-weight:700">Leave the list</button></form>`,
    ),
  );
}
