import consola from "consola";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

let db: DatabaseSync | null = null;

function handle(): DatabaseSync {
  if (!db) throw new Error("DB not initialised. Call initDb() first.");
  return db;
}

export function initDb(dataDir: string): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "reports.db");

  db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id                 TEXT PRIMARY KEY,
      received_at        TEXT NOT NULL,
      type               TEXT NOT NULL,
      title              TEXT,
      message            TEXT NOT NULL,
      contact            TEXT,

      app_id             TEXT NOT NULL,
      app_version        TEXT,
      app_build          TEXT,
      app_channel        TEXT,
      app_commit         TEXT,
      install_id         TEXT,

      platform           TEXT,
      os_version         TEXT,
      device_model       TEXT,

      identity_subject   TEXT,
      ip                 TEXT,
      user_agent         TEXT,

      payload            TEXT NOT NULL,

      triage_status      TEXT NOT NULL DEFAULT 'pending',
      triage_attempts    INTEGER NOT NULL DEFAULT 0,
      triage_verdict     TEXT,
      triage_priority    TEXT,
      triage_summary     TEXT,
      triage_area        TEXT,
      triage_duplicate_of TEXT,
      triage_reasoning   TEXT,
      triage_model       TEXT,
      triage_at          TEXT,
      triage_error       TEXT,

      read_at            TEXT,
      archived_at        TEXT,
      notified_at        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_reports_received  ON reports (received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_triage    ON reports (triage_status, received_at);
    CREATE INDEX IF NOT EXISTS idx_reports_install   ON reports (install_id);
    CREATE INDEX IF NOT EXISTS idx_reports_subject   ON reports (identity_subject);
    CREATE INDEX IF NOT EXISTS idx_reports_ip        ON reports (ip);

    CREATE TABLE IF NOT EXISTS bans (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      value       TEXT NOT NULL,
      reason      TEXT,
      created_at  TEXT NOT NULL,
      expires_at  TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bans_target ON bans (kind, value);

    -- One row per accepted report, used only for counting. Kept in SQLite
    -- rather than in memory so a restart is not a way to clear your limit.
    CREATE TABLE IF NOT EXISTS rate_events (
      bucket  TEXT NOT NULL,
      at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rate_events ON rate_events (bucket, at);

    -- Signature replay protection: a jti is good once.
    CREATE TABLE IF NOT EXISTS seen_assertions (
      jti        TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `);

  consola.info(`[db] SQLite ready at ${path}`);
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export type ReportType = "bug" | "feedback";
export type TriageStatus = "pending" | "done" | "error";

export interface ReportRow {
  id: string;
  received_at: string;
  type: ReportType;
  title: string | null;
  message: string;
  contact: string | null;
  app_id: string;
  app_version: string | null;
  app_build: string | null;
  app_channel: string | null;
  app_commit: string | null;
  install_id: string | null;
  platform: string | null;
  os_version: string | null;
  device_model: string | null;
  identity_subject: string | null;
  ip: string | null;
  user_agent: string | null;
  payload: string;
  triage_status: TriageStatus;
  triage_attempts: number;
  triage_verdict: string | null;
  triage_priority: string | null;
  triage_summary: string | null;
  triage_area: string | null;
  triage_duplicate_of: string | null;
  triage_reasoning: string | null;
  triage_model: string | null;
  triage_at: string | null;
  triage_error: string | null;
  read_at: string | null;
  archived_at: string | null;
  notified_at: string | null;
}

export interface NewReport {
  id: string;
  receivedAt: string;
  type: ReportType;
  title: string | null;
  message: string;
  contact: string | null;
  appId: string;
  appVersion: string | null;
  appBuild: string | null;
  appChannel: string | null;
  appCommit: string | null;
  installId: string | null;
  platform: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  identitySubject: string | null;
  ip: string | null;
  userAgent: string | null;
  payload: string;
}

/**
 * node:sqlite types every row as `Record<string, SQLOutputValue>`, which does
 * not structurally overlap a named interface. The queries below select exactly
 * the columns their interface names, so the conversion is sound; keeping it in
 * one place beats an `as unknown as` at every call site.
 */
function rowsAs<T>(rows: Record<string, SQLOutputValue>[]): T[] {
  return rows as unknown as T[];
}

export function insertReport(r: NewReport): void {
  handle()
    .prepare(
      `INSERT INTO reports (
         id, received_at, type, title, message, contact,
         app_id, app_version, app_build, app_channel, app_commit, install_id,
         platform, os_version, device_model,
         identity_subject, ip, user_agent, payload
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      r.id,
      r.receivedAt,
      r.type,
      r.title,
      r.message,
      r.contact,
      r.appId,
      r.appVersion,
      r.appBuild,
      r.appChannel,
      r.appCommit,
      r.installId,
      r.platform,
      r.osVersion,
      r.deviceModel,
      r.identitySubject,
      r.ip,
      r.userAgent,
      r.payload,
    );
}

export function getReport(id: string): ReportRow | null {
  const rows = rowsAs<ReportRow>(
    handle().prepare("SELECT * FROM reports WHERE id = ?").all(id),
  );
  return rows[0] ?? null;
}

export interface ListFilter {
  type?: ReportType;
  verdict?: string;
  status?: TriageStatus;
  /** "inbox" hides archived reports, "archived" shows only those. */
  shelf?: "inbox" | "archived" | "all";
  unreadOnly?: boolean;
  search?: string;
  limit: number;
  offset: number;
}

export function listReports(f: ListFilter): ReportRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];

  if (f.type) {
    where.push("type = ?");
    args.push(f.type);
  }
  if (f.verdict) {
    where.push("triage_verdict = ?");
    args.push(f.verdict);
  }
  if (f.status) {
    where.push("triage_status = ?");
    args.push(f.status);
  }
  if (f.shelf === "archived") where.push("archived_at IS NOT NULL");
  else if (f.shelf !== "all") where.push("archived_at IS NULL");
  if (f.unreadOnly) where.push("read_at IS NULL");
  if (f.search) {
    where.push("(message LIKE ? OR title LIKE ? OR triage_summary LIKE ?)");
    const like = `%${f.search}%`;
    args.push(like, like, like);
  }

  const sql =
    "SELECT * FROM reports" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY received_at DESC LIMIT ? OFFSET ?";

  return rowsAs<ReportRow>(handle().prepare(sql).all(...args, f.limit, f.offset));
}

export function countReports(f: Omit<ListFilter, "limit" | "offset">): number {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.type) {
    where.push("type = ?");
    args.push(f.type);
  }
  if (f.verdict) {
    where.push("triage_verdict = ?");
    args.push(f.verdict);
  }
  if (f.status) {
    where.push("triage_status = ?");
    args.push(f.status);
  }
  if (f.shelf === "archived") where.push("archived_at IS NOT NULL");
  else if (f.shelf !== "all") where.push("archived_at IS NULL");
  if (f.unreadOnly) where.push("read_at IS NULL");
  if (f.search) {
    where.push("(message LIKE ? OR title LIKE ? OR triage_summary LIKE ?)");
    const like = `%${f.search}%`;
    args.push(like, like, like);
  }
  const sql =
    "SELECT COUNT(*) AS n FROM reports" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "");
  const rows = handle().prepare(sql).all(...args);
  return Number(rows[0]?.n ?? 0);
}

export function markRead(id: string, at: string): void {
  handle()
    .prepare("UPDATE reports SET read_at = COALESCE(read_at, ?) WHERE id = ?")
    .run(at, id);
}

export function setArchived(id: string, at: string | null): void {
  handle().prepare("UPDATE reports SET archived_at = ? WHERE id = ?").run(at, id);
}

export function setNotified(id: string, at: string): void {
  handle().prepare("UPDATE reports SET notified_at = ? WHERE id = ?").run(at, id);
}

/** Reports waiting for the triage pass, oldest first. */
export function pendingTriage(limit: number, maxAttempts: number): ReportRow[] {
  return rowsAs<ReportRow>(
    handle()
      .prepare(
        `SELECT * FROM reports
          WHERE triage_status = 'pending' AND triage_attempts < ?
          ORDER BY received_at ASC
          LIMIT ?`,
      )
      .all(maxAttempts, limit),
  );
}

/** The last N triaged reports, for duplicate spotting. */
export function recentSummaries(limit: number): ReportRow[] {
  return rowsAs<ReportRow>(
    handle()
      .prepare(
        `SELECT * FROM reports
          WHERE triage_summary IS NOT NULL
          ORDER BY received_at DESC
          LIMIT ?`,
      )
      .all(limit),
  );
}

export interface TriageResult {
  verdict: string;
  priority: string;
  summary: string;
  area: string;
  duplicateOf: string | null;
  reasoning: string;
  model: string;
}

export function saveTriage(id: string, result: TriageResult, at: string): void {
  handle()
    .prepare(
      `UPDATE reports SET
         triage_status = 'done',
         triage_attempts = triage_attempts + 1,
         triage_verdict = ?, triage_priority = ?, triage_summary = ?,
         triage_area = ?, triage_duplicate_of = ?, triage_reasoning = ?,
         triage_model = ?, triage_at = ?, triage_error = NULL
       WHERE id = ?`,
    )
    .run(
      result.verdict,
      result.priority,
      result.summary,
      result.area,
      result.duplicateOf,
      result.reasoning,
      result.model,
      at,
      id,
    );
}

export function failTriage(id: string, message: string, maxAttempts: number): void {
  handle()
    .prepare(
      `UPDATE reports SET
         triage_attempts = triage_attempts + 1,
         triage_error = ?,
         triage_status = CASE WHEN triage_attempts + 1 >= ? THEN 'error' ELSE 'pending' END
       WHERE id = ?`,
    )
    .run(message, maxAttempts, id);
}

export function resetTriage(id: string): void {
  handle()
    .prepare(
      `UPDATE reports SET triage_status = 'pending', triage_attempts = 0,
         triage_error = NULL WHERE id = ?`,
    )
    .run(id);
}

export type BanKind = "ip" | "install" | "subject" | "app";

export interface BanRow {
  id: string;
  kind: BanKind;
  value: string;
  reason: string | null;
  created_at: string;
  expires_at: string | null;
}

export function addBan(ban: BanRow): void {
  handle()
    .prepare(
      `INSERT INTO bans (id, kind, value, reason, created_at, expires_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT (kind, value) DO UPDATE SET
         reason = excluded.reason, expires_at = excluded.expires_at`,
    )
    .run(ban.id, ban.kind, ban.value, ban.reason, ban.created_at, ban.expires_at);
}

export function removeBan(id: string): void {
  handle().prepare("DELETE FROM bans WHERE id = ?").run(id);
}

export function listBans(): BanRow[] {
  return rowsAs<BanRow>(
    handle().prepare("SELECT * FROM bans ORDER BY created_at DESC").all(),
  );
}

/** The ban covering this target, if one is in force right now. */
export function findBan(kind: BanKind, value: string, nowIso: string): BanRow | null {
  const rows = rowsAs<BanRow>(
    handle()
      .prepare(
        `SELECT * FROM bans
          WHERE kind = ? AND value = ?
            AND (expires_at IS NULL OR expires_at > ?)
          LIMIT 1`,
      )
      .all(kind, value, nowIso),
  );
  return rows[0] ?? null;
}

export function recordRateEvent(bucket: string, at: number): void {
  handle().prepare("INSERT INTO rate_events (bucket, at) VALUES (?, ?)").run(bucket, at);
}

export function countRateEvents(bucket: string, since: number): number {
  const rows = handle()
    .prepare("SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND at >= ?")
    .all(bucket, since);
  return Number(rows[0]?.n ?? 0);
}

export function pruneRateEvents(before: number): void {
  handle().prepare("DELETE FROM rate_events WHERE at < ?").run(before);
}

/** True if this assertion id has been used before. Records it either way. */
export function claimAssertion(jti: string, expiresAt: number): boolean {
  const db = handle();
  db.prepare("DELETE FROM seen_assertions WHERE expires_at < ?").run(Date.now());
  const existing = db.prepare("SELECT jti FROM seen_assertions WHERE jti = ?").all(jti);
  if (existing.length > 0) return false;
  db.prepare("INSERT INTO seen_assertions (jti, expires_at) VALUES (?, ?)").run(
    jti,
    expiresAt,
  );
  return true;
}

export interface Stats {
  total: number;
  unread: number;
  pending: number;
  bugs: number;
  feedback: number;
}

export function stats(): Stats {
  const one = (sql: string, ...args: (string | number)[]): number => {
    const rows = handle().prepare(sql).all(...args);
    return Number(rows[0]?.n ?? 0);
  };
  return {
    total: one("SELECT COUNT(*) AS n FROM reports"),
    unread: one("SELECT COUNT(*) AS n FROM reports WHERE read_at IS NULL AND archived_at IS NULL"),
    pending: one("SELECT COUNT(*) AS n FROM reports WHERE triage_status = 'pending'"),
    bugs: one("SELECT COUNT(*) AS n FROM reports WHERE type = 'bug'"),
    feedback: one("SELECT COUNT(*) AS n FROM reports WHERE type = 'feedback'"),
  };
}
