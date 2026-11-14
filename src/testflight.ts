import consola from "consola";
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Config } from "./config.ts";
import { getReport, insertReport, type NewReport } from "./db.ts";
import { normaliseReport } from "./report.ts";

const API = "https://api.appstoreconnect.apple.com";

export interface AscConfig {
  keyId: string;
  issuerId: string;
  keyPath: string;
  appId: string;
  pollMinutes: number;
}

interface Submission {
  id: string;
  attributes: Record<string, unknown>;
}

type Fetch = typeof fetch;

export function ascToken(asc: AscConfig, key: string, now: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(now / 1000);
  const head = `${b64({ alg: "ES256", kid: asc.keyId, typ: "JWT" })}.${b64({ iss: asc.issuerId, iat, exp: iat + 600, aud: "appstoreconnect-v1" })}`;
  // Apple calls a DER signature a malformed token.
  const sig = createSign("SHA256").update(head).sign({ key, dsaEncoding: "ieee-p1363" });
  return `${head}.${sig.toString("base64url")}`;
}

/** One TestFlight submission as a report. The id comes from Apple's, so a second poll skips it. */
export function toReport(
  kind: "crash" | "screenshot",
  s: Submission,
  crashLog: string | null,
  config: Config,
): NewReport {
  const a = s.attributes;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const lines = crashLog ? crashLog.split("\n").slice(0, config.maxLogLines) : [];
  const exception = crashLog?.match(/^Exception Type:\s*(.+)$/m)?.[1] ?? null;
  const shots = Array.isArray(a.screenshots)
    ? a.screenshots.map((x) => text((x as Record<string, unknown>)?.url)).filter(Boolean)
    : [];

  const report = normaliseReport(
    {
      type: kind === "crash" ? "bug" : "feedback",
      title: kind === "crash" ? "TestFlight crash" : "TestFlight feedback",
      message: text(a.comment) ?? (kind === "crash" ? "Crashed, no comment." : "No comment."),
      contact: text(a.email),
      app: { locale: text(a.locale) },
      device: {
        platform: text(a.devicePlatform)?.toLowerCase() ?? "ios",
        osVersion: text(a.osVersion),
        model: text(a.deviceModel),
        arch: text(a.architecture),
        batteryPct: num(a.batteryPercentage),
        timezone: text(a.timeZone),
        screen: { width: num(a.screenWidthInPoints), height: num(a.screenHeightInPoints) },
      },
      error: crashLog ? { name: "TestFlight crash", message: exception } : undefined,
      logs: lines,
      extra: { source: "testflight", submissionId: s.id, bundleId: text(a.buildBundleId), screenshots: shots },
    },
    "mobile",
    config,
  );
  const version = crashLog?.match(/^Version:\s*(\S+)\s*\((\d+)\)/m);

  return {
    id: `tf_${s.id}`,
    receivedAt: text(a.createdDate) ?? new Date().toISOString(),
    type: report.type,
    title: report.title,
    message: report.message,
    contact: report.contact,
    appId: "mobile",
    appVersion: version?.[1] ?? null,
    appBuild: version?.[2] ?? null,
    appChannel: "testflight",
    appCommit: null,
    installId: null,
    platform: report.device.platform,
    osVersion: report.device.osVersion,
    deviceModel: report.device.model,
    identitySubject: null,
    ip: null,
    userAgent: null,
    payload: JSON.stringify(report),
  };
}

/** Pulls TestFlight crash and screenshot feedback from App Store Connect into the inbox. */
export class TestflightPoller {
  private timer: NodeJS.Timeout | null = null;
  private readonly config: Config;
  private readonly onNew: (id: string) => void;
  private readonly fetcher: Fetch;

  constructor(config: Config, onNew: (id: string) => void, fetcher: Fetch = fetch) {
    this.config = config;
    this.onNew = onNew;
    this.fetcher = fetcher;
  }

  start(): void {
    const asc = this.config.asc;
    if (!asc) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), asc.pollMinutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async poll(now = Date.now()): Promise<number> {
    const asc = this.config.asc;
    if (!asc) return 0;
    try {
      const token = ascToken(asc, readFileSync(asc.keyPath, "utf8"), now);
      const get = async (path: string) => {
        const res = await this.fetcher(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`${path} answered ${res.status}`);
        return (await res.json()) as { data: unknown };
      };
      let added = 0;
      for (const kind of ["crash", "screenshot"] as const) {
        const list = await get(
          `/v1/apps/${asc.appId}/betaFeedback${kind === "crash" ? "Crash" : "Screenshot"}Submissions?limit=50&sort=-createdDate`,
        );
        for (const s of (list.data as Submission[]) ?? []) {
          if (getReport(`tf_${s.id}`)) continue;
          let log: string | null = null;
          if (kind === "crash") {
            const res = await get(`/v1/betaFeedbackCrashSubmissions/${s.id}/crashLog`).catch(() => null);
            const text = (res?.data as Submission | undefined)?.attributes?.logText;
            log = typeof text === "string" ? text : null;
          }
          const report = toReport(kind, s, log, this.config);
          insertReport(report);
          this.onNew(report.id);
          added++;
        }
      }
      if (added) consola.info(`[testflight] ${added} new submission(s)`);
      return added;
    } catch (err) {
      consola.warn(`[testflight] poll failed: ${(err as Error).message}`);
      return 0;
    }
  }
}
