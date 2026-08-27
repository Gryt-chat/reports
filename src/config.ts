import consola from "consola";

/**
 * Everything this service reads from the environment, resolved once at boot.
 *
 * Defaults are the ones that make sense for the deployment behind
 * reports.gryt.chat, not the ones that make a first run easy — an open POST
 * endpoint with no key and no limits is the failure mode this whole service is
 * trying to avoid, so it has to be asked for explicitly.
 */
export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** When this process came up. Reported to whoever has signed in. */
  startedAt: number;
  /** Where `yarn build` in ui/ put the dashboard. */
  uiDir: string;
  version: string;

  /** Origins allowed to POST from a browser. The web client is one. */
  corsOrigins: string[];

  /** App id → the key that app ships. See `apps.ts`. */
  appKeys: Map<string, string>;
  allowUnkeyed: boolean;
  requireSignature: boolean;

  maxBodyBytes: number;
  maxMessageChars: number;
  maxLogLines: number;
  maxLogLineChars: number;
  maxExtraChars: number;

  /** Reports allowed per window, counted separately per bucket. */
  limits: {
    /**
     * The shortest gap between one client's reports.
     *
     * The cheapest thing here and the one that does the most: a script posting
     * in a loop is stopped by the first pair of requests, before any of the
     * hourly counters have noticed. Short enough that somebody filing a second
     * genuine report is not really inconvenienced, and unlike the counters
     * below it answers honestly — see `assertWithinLimits`.
     */
    minIntervalSec: number;
    perMinute: number;
    perHourPerIp: number;
    perHourPerInstall: number;
    perDayPerIp: number;
  };

  /**
   * Banning whoever keeps sending junk, decided by the triage pass.
   *
   * Only the `noise` verdict counts — empty submissions, test posts, spam,
   * nothing to do with Gryt. `not_a_bug` deliberately does not, because that
   * verdict means a feature request or a support question, and the person who
   * sends three of those is the most engaged user Gryt has rather than an
   * abuser.
   *
   * The ban expires. A permanent one taken out by a model on three strikes is
   * a decision nobody reviews, and the failure is invisible: somebody stops
   * being able to report bugs and never finds out why.
   */
  autoBan: {
    /** Noise reports before a ban. 0 turns this off. */
    threshold: number;
    /** How far back to count them. */
    windowHours: number;
    /** How long the ban lasts. */
    days: number;
  };

  trustProxy: boolean;
  /**
   * The addresses whose forwarding headers are believed.
   *
   * Empty means believe any peer, which is only right when nothing but the
   * proxy can reach the port.
   */
  trustedProxies: string[];

  adminToken: string | null;

  triage: {
    enabled: boolean;
    /** Which thing reads the reports. See models.ts. */
    provider: "anthropic" | "ollama";
    model: string;
    ollamaUrl: string;
    keepAlive: string;
    timeoutMs: number;
    think: boolean;
    pollMs: number;
    batch: number;
    maxAttempts: number;
    /** Recent reports shown to the triage pass so it can spot duplicates. */
    duplicateWindow: number;
  };

  /**
   * The board a report can be filed onto.
   *
   * A write credential for Vikunja, so it lives here rather than anywhere in
   * the repository. Without a token the Create task button is not offered —
   * an inbox that shows a button which cannot work is worse than one that does
   * not show it.
   */
  vikunja: {
    url: string;
    token: string | null;
    projectId: number;
  };

  /**
   * The weekly digest, and where it is sent from.
   *
   * `GRYT_SMTP_*` rather than a set of its own, because the box already has
   * those pointed at Postmark for the rest of Gryt. A second copy would be a
   * second thing to rotate.
   *
   * Without a host the digest does not run and the service starts as normal.
   * It is an addition, not a dependency.
   */
  digest: {
    enabled: boolean;
    /** Day of week to send on, 0 = Sunday. */
    day: number;
    /** Hour, local to the service's clock. */
    hour: number;
    smtp: {
      host: string;
      port: number;
      user: string | null;
      pass: string | null;
      from: string;
      fromName: string;
      replyTo: string | null;
    };
  };

  /**
   * The review gate for drafted release notes.
   *
   * `ops/internal/changelog-notes.mjs` drafts a note after a release and posts
   * it here rather than writing the file the changelog page reads, so nothing
   * a model wrote is live until somebody has read it in the inbox.
   *
   * Without a key the endpoint is not there at all. It is a write endpoint on
   * a service whose whole point is that a public POST route is guarded, and an
   * unconfigured deployment must not be the exception.
   *
   * Without a file nothing is published anywhere — the inbox still takes and
   * shows drafts, which is what a deployment that is not the one behind
   * gryt.chat should do.
   */
  changelog: {
    key: string | null;
    file: string | null;
  };

  discordWebhookUrl: string | null;
  /** Notify on arrival, after triage, or not at all. */
  notifyOn: "receive" | "triage" | "never";
  /** Where the admin inbox lives, for the links in a notification. */
  publicUrl: string | null;
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    consola.warn(`[config] ${name}="${raw}" is not a number, using ${fallback}`);
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function list(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `REPORTS_APP_KEYS=mobile:key1,desktop:key2`.
 *
 * One key per app rather than one key for everything, because the point of the
 * header is to be revocable: a key pulled out of the iOS bundle should not
 * force a desktop release too.
 */
function parseAppKeys(raw: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0 || idx === trimmed.length - 1) {
      consola.warn(`[config] ignoring malformed REPORTS_APP_KEYS entry "${trimmed}"`);
      continue;
    }
    keys.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
  }
  return keys;
}

export function loadConfig(): Config {
  const appKeys = parseAppKeys(process.env.REPORTS_APP_KEYS || "");
  const allowUnkeyed = bool("REPORTS_ALLOW_UNKEYED", false);

  if (appKeys.size === 0 && !allowUnkeyed) {
    throw new Error(
      "No REPORTS_APP_KEYS configured. This service exposes a public POST " +
        "endpoint, so it refuses to start without one. Set REPORTS_APP_KEYS " +
        '("mobile:<key>,desktop:<key>") or REPORTS_ALLOW_UNKEYED=true if you ' +
        "really mean to take reports from anyone.",
    );
  }

  const adminToken = process.env.REPORTS_ADMIN_TOKEN?.trim() || null;
  if (!adminToken) {
    consola.warn("[config] No REPORTS_ADMIN_TOKEN set — the admin inbox is off.");
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const ollamaUrl = process.env.REPORTS_OLLAMA_URL?.trim() || "";

  // A URL is the only thing Ollama needs, so having one is what picks it. The
  // API needs a key, so having one picks that. Naming the provider outright
  // wins over both, which is how you point them at the same report to compare.
  const provider: Config["triage"]["provider"] =
    (process.env.REPORTS_TRIAGE_PROVIDER?.trim() as Config["triage"]["provider"]) ||
    (ollamaUrl ? "ollama" : "anthropic");

  const configured = provider === "ollama" ? Boolean(ollamaUrl) : Boolean(anthropicKey);
  const triageEnabled = bool("REPORTS_TRIAGE_ENABLED", configured);

  if (triageEnabled && !configured) {
    consola.warn(
      `[config] Triage is on with provider "${provider}" but nothing is ` +
        "configured for it. Reports will queue as pending until there is.",
    );
  }

  const defaultModel =
    provider === "ollama"
      ? // Comfortable next to whatever else is on the card, quick on a 3060,
        // and the schema is what keeps its answer in shape rather than its size.
        "qwen3:8b"
      : "claude-opus-5";

  return {
    host: process.env.HOST || "0.0.0.0",
    port: int("PORT", 8080, 1, 65535),
    dataDir: process.env.DATA_DIR || "./data",
    startedAt: Date.now(),
    uiDir: process.env.REPORTS_UI_DIR || "./dist-ui",
    version: process.env.REPORTS_VERSION?.trim().replace(/^v/, "") || "dev",

    corsOrigins: list("REPORTS_CORS_ORIGINS"),

    appKeys,
    allowUnkeyed,
    requireSignature: bool("REPORTS_REQUIRE_SIGNATURE", false),

    maxBodyBytes: int("REPORTS_MAX_BODY_BYTES", 256 * 1024, 4096, 4 * 1024 * 1024),
    maxMessageChars: int("REPORTS_MAX_MESSAGE_CHARS", 8000, 200, 100_000),
    maxLogLines: int("REPORTS_MAX_LOG_LINES", 200, 0, 2000),
    maxLogLineChars: int("REPORTS_MAX_LOG_LINE_CHARS", 500, 80, 4000),
    maxExtraChars: int("REPORTS_MAX_EXTRA_CHARS", 8000, 0, 100_000),

    limits: {
      minIntervalSec: int("REPORTS_MIN_INTERVAL_SEC", 10, 0, 3600),
      perMinute: int("REPORTS_LIMIT_PER_MINUTE", 3, 1, 1000),
      perHourPerIp: int("REPORTS_LIMIT_PER_HOUR_PER_IP", 10, 1, 10_000),
      perHourPerInstall: int("REPORTS_LIMIT_PER_HOUR_PER_INSTALL", 10, 1, 10_000),
      perDayPerIp: int("REPORTS_LIMIT_PER_DAY_PER_IP", 40, 1, 100_000),
    },

    autoBan: {
      threshold: int("REPORTS_AUTO_BAN_NOISE", 3, 0, 100),
      windowHours: int("REPORTS_AUTO_BAN_WINDOW_H", 24, 1, 8760),
      days: int("REPORTS_AUTO_BAN_DAYS", 7, 1, 3650),
    },

    trustProxy: bool("REPORTS_TRUST_PROXY", true),
    trustedProxies: list("REPORTS_TRUSTED_PROXIES"),

    adminToken,

    triage: {
      enabled: triageEnabled,
      provider,
      model: process.env.REPORTS_TRIAGE_MODEL?.trim() || defaultModel,
      ollamaUrl: ollamaUrl || "http://127.0.0.1:11434",
      keepAlive: process.env.REPORTS_OLLAMA_KEEP_ALIVE?.trim() || "5m",
      timeoutMs: int("REPORTS_TRIAGE_TIMEOUT_MS", 120_000, 5_000, 900_000),
      // Off, because sorting a report into four fields is not a problem to
      // reason through, and on a model running half in RAM the reasoning is
      // most of the wall clock. Turn it on to trade minutes for judgement.
      think: bool("REPORTS_TRIAGE_THINK", false),
      pollMs: int("REPORTS_TRIAGE_POLL_MS", 15_000, 1000, 3_600_000),
      batch: int("REPORTS_TRIAGE_BATCH", 5, 1, 50),
      maxAttempts: int("REPORTS_TRIAGE_MAX_ATTEMPTS", 3, 1, 20),
      duplicateWindow: int("REPORTS_TRIAGE_DUPLICATE_WINDOW", 25, 0, 200),
    },

    vikunja: {
      url: (process.env.REPORTS_VIKUNJA_URL?.trim() || "https://tasks.sivert.io").replace(
        /\/$/,
        "",
      ),
      token: process.env.REPORTS_VIKUNJA_TOKEN?.trim() || null,
      projectId: int("REPORTS_VIKUNJA_PROJECT", 2, 1, 1_000_000),
    },
    digest: (() => {
      const host = process.env.GRYT_SMTP_HOST?.trim() || "";
      // Quotes survive being read out of a .env by some shells, and an address
      // wrapped in them is a bounce nobody sees until they look for the digest.
      const unquote = (v: string | undefined) => v?.trim().replace(/^"|"$/g, "") || "";
      return {
        enabled: bool("REPORTS_DIGEST_ENABLED", Boolean(host)),
        day: int("REPORTS_DIGEST_DAY", 1, 0, 6),
        hour: int("REPORTS_DIGEST_HOUR", 9, 0, 23),
        smtp: {
          host,
          port: int("GRYT_SMTP_PORT", 587, 1, 65535),
          user: process.env.GRYT_SMTP_USER?.trim() || null,
          pass: process.env.GRYT_SMTP_PASS || null,
          from: unquote(process.env.GRYT_SMTP_FROM) || "hello@gryt.chat",
          fromName: unquote(process.env.GRYT_SMTP_FROM_NAME) || "Gryt",
          replyTo: unquote(process.env.GRYT_SMTP_REPLY_TO) || null,
        },
      };
    })(),

    changelog: {
      key: process.env.REPORTS_CHANGELOG_KEY?.trim() || null,
      file: process.env.REPORTS_CHANGELOG_FILE?.trim() || null,
    },

    discordWebhookUrl: process.env.REPORTS_DISCORD_WEBHOOK_URL?.trim() || null,
    notifyOn: (process.env.REPORTS_NOTIFY_ON as Config["notifyOn"]) || "triage",
    publicUrl: process.env.REPORTS_PUBLIC_URL?.trim().replace(/\/$/, "") || null,
  };
}
