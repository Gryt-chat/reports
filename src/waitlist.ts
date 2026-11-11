import consola from "consola";
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createTransport } from "nodemailer";

import type { Config } from "./config.ts";
import { joinWaitlist, leaveWaitlist } from "./db.ts";
import { clientIp, header, HttpError, isAllowedOrigin, readBody, sendHtml, sendJson } from "./http.ts";
import { markPng } from "./digest.ts";
import { MARK_CID } from "./digestMail.ts";
import { withinLimit } from "./unknownApps.ts";
import { welcomeHtml } from "./waitlistMail.ts";

const PER_HOUR_PER_IP = 5;

export type Mail = { to: string; subject: string; text: string; html?: string };
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
      "You'll be the first to know when Gryt Cloud opens: your own Gryt server, always online, and we run it for you.",
      "",
      "50% off your first three months on Friends or Community. The code comes in the email when it opens.",
      "",
      "That's the only email you'll get from us until then.",
      "",
      "While you wait:",
      "Download Gryt: https://gryt.chat/download",
      "Join our server: https://gryt.chat/community",
      "",
      "Thanks for signing up!",
      "",
      "Sivert, who makes Gryt",
      "",
      `You got this because this address was entered at gryt.chat/cloud. Didn't sign up, or changed your mind? Leave the list: ${leaveUrl}`,
    ].join("\n"),
    html: welcomeHtml(leaveUrl),
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
  const mark = markPng();
  return async (mail) => {
    await transport.sendMail({
      from: { name: smtp.fromName, address: smtp.from },
      replyTo: smtp.replyTo ?? undefined,
      ...mail,
      attachments: mail.html && mark ? [{ filename: "gryt.png", content: mark, cid: MARK_CID, contentType: "image/png" }] : undefined,
    });
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
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gryt Cloud</title>` +
  `<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#111318;color:#e0e0e6;font:16px/1.6 'Atkinson Hyperlegible',system-ui,sans-serif">` +
  `<main style="width:min(440px,calc(100% - 32px));padding:30px;border:1px solid #2b303d;border-radius:20px;background:#1a1d24">${body}</main></body>`;

/* GET only shows a button: mail scanners open every link, and a GET that deleted would take people off the list. */
export async function leave(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const token = url.searchParams.get("t") ?? "";
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HttpError(404, "not_found", "No such link");

  if (req.method === "POST") {
    leaveWaitlist(hashToken(token));
    sendHtml(res, 200, page(`<h1 style="margin:0;font-size:24px">You're off the list</h1><p style="margin:10px 0 0;color:#888">You won't hear from us about Gryt Cloud. If that was a mistake, sign up again at <a href="https://gryt.chat/cloud" style="color:#b4afff">gryt.chat/cloud</a>.</p>`));
    return;
  }
  sendHtml(
    res,
    200,
    page(
      `<h1 style="margin:0;font-size:24px">Leave the Gryt Cloud list?</h1><p style="margin:10px 0 20px;color:#888">You won't get the email when it opens, or the discount.</p>` +
        `<form method="post"><button style="font:inherit;min-height:44px;padding:0 22px;border-radius:999px;border:0;background:#968ff8;color:#14161d;font-weight:700;cursor:pointer">Leave the list</button></form>`,
    ),
  );
}
