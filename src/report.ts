import { HttpError } from "./http.ts";

/**
 * What a report is, and what a client is expected to fill in. **Only `type` and
 * `message` are required, and a bad field is truncated or dropped rather than
 * rejected** — a report lost to a validation error is a bug nobody hears about.
 *
 * The whole normalised object is stored alongside the columns, so a field an
 * app sends before this service knows about it still lands in `extra` and is
 * still there to read.
 */
export interface NormalisedReport {
  type: "bug" | "feedback";
  title: string | null;
  /** What they wrote. The only part a person actually typed. */
  message: string;
  /** Optional, and only if they offered it: how to get back to them. */
  contact: string | null;

  app: {
    /** Which app: `mobile`, `desktop`, `web`, `cli`. Taken from the header. */
    id: string;
    version: string | null;
    build: string | null;
    channel: string | null;
    commit: string | null;
    /** Random per install, not per person. Ties one installation's reports together. */
    installId: string | null;
    locale: string | null;
  };

  device: {
    platform: string | null;
    osVersion: string | null;
    model: string | null;
    manufacturer: string | null;
    arch: string | null;
    isEmulator: boolean | null;
    screen: { width: number | null; height: number | null; scale: number | null } | null;
    memoryMb: number | null;
    diskFreeMb: number | null;
    batteryPct: number | null;
    timezone: string | null;
  };

  runtime: {
    engine: string | null;
    engineVersion: string | null;
    nodeVersion: string | null;
    chromeVersion: string | null;
    electronVersion: string | null;
    reactNativeVersion: string | null;
    expoVersion: string | null;
    userAgent: string | null;
  };

  context: {
    /** Where in the app they were when they hit the button. */
    route: string | null;
    serverVersion: string | null;
    sfuVersion: string | null;
    connected: boolean | null;
    voiceActive: boolean | null;
    networkType: string | null;
    online: boolean | null;
    sessionUptimeSec: number | null;
    permissions: Record<string, string> | null;
  };

  /** Set when the report came out of a crash handler rather than a form. */
  error: { name: string | null; message: string | null; stack: string | null } | null;

  /** The tail of the app's own log, if it keeps one. */
  logs: string[];

  /** Anything an app wants to send that this service has no column for. */
  extra: Record<string, unknown> | null;
}

export interface Limits {
  maxMessageChars: number;
  maxLogLines: number;
  maxLogLineChars: number;
  maxExtraChars: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number): string | null {
  if (typeof value === "number" || typeof value === "boolean") value = String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function num(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/**
 * Strip the control characters a terminal or a log viewer would act on.
 *
 * Newlines and tabs stay — a stack trace is unreadable without them.
 */
export function clean(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function section(raw: unknown, key: string): Record<string, unknown> {
  const value = isObject(raw) ? raw[key] : undefined;
  return isObject(value) ? value : {};
}

/**
 * Permissions come in as whatever the platform calls them — `granted`,
 * `denied`, `undetermined`, or a bare boolean on the web. Normalising to
 * strings keeps the shape stable without pretending the platforms agree.
 */
function permissions(raw: unknown): Record<string, string> | null {
  if (!isObject(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw).slice(0, 12)) {
    const name = str(key, 40);
    const state = str(value, 40);
    if (name && state) out[name] = state;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Free-form extras, bounded by what they serialise to rather than by key count.
 * An app that sends something enormous loses the extras, not the report.
 */
function extras(raw: unknown, maxChars: number): Record<string, unknown> | null {
  if (!isObject(raw) || maxChars === 0) return null;
  try {
    const json = JSON.stringify(raw);
    if (!json || json.length > maxChars) return null;
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function normaliseReport(
  raw: unknown,
  appId: string,
  limits: Limits,
): NormalisedReport {
  if (!isObject(raw)) {
    throw new HttpError(400, "invalid_body", "Body must be a JSON object");
  }

  const type = str(raw.type, 20)?.toLowerCase();
  if (type !== "bug" && type !== "feedback") {
    throw new HttpError(400, "invalid_type", 'type must be "bug" or "feedback"');
  }

  const message = str(raw.message, limits.maxMessageChars);
  if (!message) {
    throw new HttpError(400, "empty_message", "message is required");
  }

  const app = section(raw, "app");
  const device = section(raw, "device");
  const runtime = section(raw, "runtime");
  const context = section(raw, "context");
  const error = section(raw, "error");
  const screen = section(device, "screen");

  const logs = Array.isArray(raw.logs)
    ? raw.logs
        .slice(-limits.maxLogLines)
        .map((line) => str(line, limits.maxLogLineChars))
        .filter((line): line is string => line !== null)
        .map(clean)
    : [];

  const hasError = Object.keys(error).length > 0;

  return {
    type,
    title: str(raw.title, 200),
    message: clean(message),
    contact: str(raw.contact, 200),

    app: {
      id: appId,
      version: str(app.version, 40),
      build: str(app.build, 40),
      channel: str(app.channel, 20),
      commit: str(app.commit, 60),
      installId: str(app.installId, 100),
      locale: str(app.locale, 20),
    },

    device: {
      platform: str(device.platform, 20)?.toLowerCase() ?? null,
      osVersion: str(device.osVersion, 40),
      model: str(device.model, 80),
      manufacturer: str(device.manufacturer, 60),
      arch: str(device.arch, 20),
      isEmulator: bool(device.isEmulator),
      screen:
        Object.keys(screen).length > 0
          ? {
              width: num(screen.width),
              height: num(screen.height),
              scale: num(screen.scale),
            }
          : null,
      memoryMb: num(device.memoryMb),
      diskFreeMb: num(device.diskFreeMb),
      batteryPct: num(device.batteryPct),
      timezone: str(device.timezone, 60),
    },

    runtime: {
      engine: str(runtime.engine, 30),
      engineVersion: str(runtime.engineVersion, 40),
      nodeVersion: str(runtime.nodeVersion, 40),
      chromeVersion: str(runtime.chromeVersion, 40),
      electronVersion: str(runtime.electronVersion, 40),
      reactNativeVersion: str(runtime.reactNativeVersion, 40),
      expoVersion: str(runtime.expoVersion, 40),
      userAgent: str(runtime.userAgent, 400),
    },

    context: {
      route: str(context.route, 200),
      serverVersion: str(context.serverVersion, 40),
      sfuVersion: str(context.sfuVersion, 40),
      connected: bool(context.connected),
      voiceActive: bool(context.voiceActive),
      networkType: str(context.networkType, 20),
      online: bool(context.online),
      sessionUptimeSec: num(context.sessionUptimeSec),
      permissions: permissions(context.permissions),
    },

    error: hasError
      ? {
          name: str(error.name, 100),
          message: str(error.message, 1000),
          stack: str(error.stack, 8000),
        }
      : null,

    logs,
    extra: extras(raw.extra, limits.maxExtraChars),
  };
}

/** Sortable, unambiguous, and short enough to paste into a message. */
export function newReportId(now: number, random: string): string {
  return `rep_${now.toString(36)}${random}`;
}
