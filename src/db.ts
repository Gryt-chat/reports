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
      task_id            INTEGER,
      task_url           TEXT,
      triage_verdict     TEXT,
      triage_priority    TEXT,
      triage_summary     TEXT,
      triage_area        TEXT,
      triage_duplicate_of TEXT,
      triage_reasoning   TEXT,
      triage_model       TEXT,
      triage_at          TEXT,
      triage_error       TEXT,

      status             TEXT NOT NULL DEFAULT 'new',
      status_note        TEXT,
      status_at          TEXT,

      read_at            TEXT,
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

    -- Who may read the inbox.
    --
    -- Keycloak says who somebody is; this says whether they get in. Somebody
    -- is added by whatever you know about them — their Keycloak user id if you
    -- have it, otherwise their username or email — and the id is filled in the
    -- first time they sign in, so later matches are on the one thing that
    -- cannot be changed by editing a profile.
    CREATE TABLE IF NOT EXISTS admins (
      id            TEXT PRIMARY KEY,
      identifier    TEXT NOT NULL,
      subject       TEXT,
      name          TEXT,
      note          TEXT,
      added_at      TEXT NOT NULL,
      added_by      TEXT,
      last_seen_at  TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_identifier ON admins (identifier);
    CREATE INDEX IF NOT EXISTS idx_admins_subject ON admins (subject);

    -- Signature replay protection: a jti is good once.
    CREATE TABLE IF NOT EXISTS seen_assertions (
      jti        TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `);

  migrate(db);

  consola.info(`[db] SQLite ready at ${path}`);
}

/**
 * Add columns a database made by an older build does not have.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * without this a service that has been taking reports for a while would start
 * up fine and then fail on the first query naming a new column.
 */
function migrate(db: DatabaseSync): void {
  const columns = new Set(
    db.prepare("PRAGMA table_info(reports)").all().map((row) => String(row.name)),
  );

  const additions: [string, string][] = [
    ["status", "TEXT NOT NULL DEFAULT 'new'"],
    ["status_note", "TEXT"],
    ["status_at", "TEXT"],
    // The task this report became, so the same report is not filed twice.
    ["task_id", "INTEGER"],
    ["task_url", "TEXT"],
  ];

  for (const [name, definition] of additions) {
    if (columns.has(name)) continue;
    db.exec(`ALTER TABLE reports ADD COLUMN ${name} ${definition}`);
    consola.info(`[db] Added reports.${name}`);
  }

  // Archiving was what closing a report used to mean, before there was
  // anywhere to say why. Anything already archived is resolved.
  if (columns.has("archived_at")) {
    db.exec(
      "UPDATE reports SET status = 'resolved' WHERE archived_at IS NOT NULL AND status = 'new'",
    );
  }

  // After the column exists, not in the block above: on a database from an
  // older build there is nothing to index until this has run.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status, received_at)",
  );
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export type ReportType = "bug" | "feedback";
export type TriageStatus = "pending" | "done" | "error";

/**
 * What has been decided about a report, as opposed to what triage thinks of it.
 *
 * `new` and `open` are the two that are still yours to deal with, and the
 * inbox shows those by default. The other three are ways of being done: fixed,
 * decided against, or already covered by another report. A closed report is
 * still there and still searchable — nothing here deletes one.
 */
export const REPORT_STATUSES = [
  "new",
  "open",
  "resolved",
  "wont_do",
  "duplicate",
] as const;

export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** The statuses that mean somebody still has to do something. */
export const OPEN_STATUSES: ReportStatus[] = ["new", "open"];

export function isReportStatus(value: unknown): value is ReportStatus {
  return REPORT_STATUSES.includes(value as ReportStatus);
}

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
  /** The Vikunja task filed from this report, if one was. */
  task_id: number | null;
  task_url: string | null;
  triage_verdict: string | null;
  triage_priority: string | null;
  triage_summary: string | null;
  triage_area: string | null;
  triage_duplicate_of: string | null;
  triage_reasoning: string | null;
  triage_model: string | null;
  triage_at: string | null;
  triage_error: string | null;
  status: ReportStatus;
  status_note: string | null;
  status_at: string | null;
  read_at: string | null;
  notified_at: string | null;
}

/**
 * A report without its `payload`.
 *
 * The payload is the whole diagnostics blob and is by far the biggest column,
 * so a listing that returned it would be mostly bytes nobody asked for —
 * whether the thing reading is a browser or a model going through the queue.
 */
export type ReportSummary = Omit<ReportRow, "payload">;

/** Every column except the payload, for listings. */
const SUMMARY_COLUMNS = `id, received_at, type, title, message, contact,
  app_id, app_version, app_build, app_channel, app_commit, install_id,
  platform, os_version, device_model, identity_subject, ip, user_agent,
  triage_status, triage_attempts, triage_verdict, triage_priority,
  triage_summary, triage_area, triage_duplicate_of, triage_reasoning,
  triage_model, triage_at, triage_error,
  status, status_note, status_at, task_id, task_url, read_at, notified_at`;

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
  /** What triage did with it, not what you decided. */
  triageStatus?: TriageStatus;
  status?: ReportStatus;
  /** "open" is new and open, "closed" is the other three. */
  shelf?: "open" | "closed" | "all";
  unreadOnly?: boolean;
  search?: string;
  limit: number;
  offset: number;
}

type CountFilter = Omit<ListFilter, "limit" | "offset">;

/** The WHERE clause both the listing and the count are built from. */
function whereFor(f: CountFilter): { sql: string; args: (string | number)[] } {
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
  if (f.triageStatus) {
    where.push("triage_status = ?");
    args.push(f.triageStatus);
  }
  if (f.status) {
    where.push("status = ?");
    args.push(f.status);
  }
  // Naming a status is a more specific ask than either shelf, so it wins. The
  // two together would otherwise contradict each other and return nothing.
  if (f.status) {
    // already filtered above
  } else if (f.shelf === "closed") {
    where.push(`status NOT IN (${OPEN_STATUSES.map(() => "?").join(",")})`);
    args.push(...OPEN_STATUSES);
  } else if (f.shelf !== "all") {
    where.push(`status IN (${OPEN_STATUSES.map(() => "?").join(",")})`);
    args.push(...OPEN_STATUSES);
  }
  if (f.unreadOnly) where.push("read_at IS NULL");
  if (f.search) {
    where.push("(message LIKE ? OR title LIKE ? OR triage_summary LIKE ?)");
    const like = `%${f.search}%`;
    args.push(like, like, like);
  }

  return { sql: where.length ? ` WHERE ${where.join(" AND ")}` : "", args };
}

export function listReports(f: ListFilter): ReportSummary[] {
  const { sql, args } = whereFor(f);
  return rowsAs<ReportSummary>(
    handle()
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM reports${sql}
          ORDER BY received_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, f.limit, f.offset),
  );
}

export function countReports(f: CountFilter): number {
  const { sql, args } = whereFor(f);
  const rows = handle().prepare(`SELECT COUNT(*) AS n FROM reports${sql}`).all(...args);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Decide what happens to a report.
 *
 * The note is where the reason goes — a Vikunja id for something now tracked,
 * a sentence for something turned down. A closed report keeps everything it
 * arrived with; closing is a label, not a delete.
 */
/**
 * Record the task a report became.
 *
 * Both directions matter: the task names the report in its description, and
 * this is the other half, so the inbox can say a report has already been filed
 * rather than offering to file it again.
 */
export function setTask(id: string, taskId: number, taskUrl: string): void {
  handle()
    .prepare("UPDATE reports SET task_id = ?, task_url = ? WHERE id = ?")
    .run(taskId, taskUrl, id);
}

export function setStatus(
  id: string,
  status: ReportStatus,
  note: string | null,
  at: string,
): void {
  handle()
    .prepare("UPDATE reports SET status = ?, status_note = ?, status_at = ? WHERE id = ?")
    .run(status, note, at, id);
}

export function markRead(id: string, at: string): void {
  handle()
    .prepare("UPDATE reports SET read_at = COALESCE(read_at, ?) WHERE id = ?")
    .run(at, id);
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

/**
 * How many reports from this submitter triage called `noise` lately.
 *
 * `identity_subject` first, `ip` second, because the subject survives a change
 * of network and an address does not. Counted from `received_at` rather than
 * from when triage ran: somebody who posts ten things in a minute and is
 * triaged an hour later should count as ten in that minute.
 */
export function countNoiseFrom(
  kind: "subject" | "ip",
  value: string,
  sinceIso: string,
): number {
  const column = kind === "subject" ? "identity_subject" : "ip";
  const rows = handle()
    .prepare(
      `SELECT COUNT(*) AS n FROM reports
        WHERE ${column} = ? AND triage_verdict = 'noise' AND received_at >= ?`,
    )
    .all(value, sinceIso);
  return Number(rows[0]?.n ?? 0);
}

/** The report ids behind that count, for a ban reason somebody can check. */
export function noiseReportIds(
  kind: "subject" | "ip",
  value: string,
  sinceIso: string,
  limit: number,
): string[] {
  const column = kind === "subject" ? "identity_subject" : "ip";
  const rows = handle()
    .prepare(
      `SELECT id FROM reports
        WHERE ${column} = ? AND triage_verdict = 'noise' AND received_at >= ?
        ORDER BY received_at DESC LIMIT ?`,
    )
    .all(value, sinceIso, limit);
  return rows.map((r) => String((r as { id: unknown }).id));
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

export interface AdminRow {
  id: string;
  /** What was typed when they were added: a user id, a username or an email. */
  identifier: string;
  /** The Keycloak user id, once they have signed in at least once. */
  subject: string | null;
  name: string | null;
  note: string | null;
  added_at: string;
  added_by: string | null;
  last_seen_at: string | null;
}

export function listAdmins(): AdminRow[] {
  return rowsAs<AdminRow>(
    handle().prepare("SELECT * FROM admins ORDER BY added_at ASC").all(),
  );
}

export function countAdmins(): number {
  const rows = handle().prepare("SELECT COUNT(*) AS n FROM admins").all();
  return Number(rows[0]?.n ?? 0);
}

export function addAdmin(row: {
  id: string;
  identifier: string;
  note: string | null;
  addedAt: string;
  addedBy: string | null;
}): void {
  handle()
    .prepare(
      `INSERT INTO admins (id, identifier, note, added_at, added_by)
       VALUES (?,?,?,?,?)
       ON CONFLICT (identifier) DO UPDATE SET note = excluded.note`,
    )
    .run(row.id, row.identifier, row.note, row.addedAt, row.addedBy);
}

export function removeAdmin(id: string): void {
  handle().prepare("DELETE FROM admins WHERE id = ?").run(id);
}

/**
 * Find the entry admitting this person.
 *
 * Matched on the Keycloak user id first, since that is the one thing about an
 * account nobody can change. Username and email are how somebody gets added
 * before they have ever signed in, and stop being consulted for that entry the
 * moment the id is known.
 */
export function findAdmin(
  subject: string,
  username: string,
  email: string | null,
): AdminRow | null {
  const rows = rowsAs<AdminRow>(
    handle()
      .prepare(
        `SELECT * FROM admins
          WHERE subject = ?
             OR (subject IS NULL AND (
                   LOWER(identifier) = LOWER(?)
                OR LOWER(identifier) = LOWER(?)
                OR identifier = ?))
          LIMIT 1`,
      )
      .all(subject, username, email ?? "\u0000no-email", subject),
  );
  return rows[0] ?? null;
}

/** Record that they were here, and pin the entry to their user id. */
export function touchAdmin(
  id: string,
  subject: string,
  name: string,
  at: string,
): void {
  handle()
    .prepare("UPDATE admins SET subject = ?, name = ?, last_seen_at = ? WHERE id = ?")
    .run(subject, name, at, id);
}

export interface Stats {
  total: number;
  open: number;
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
  const openList = OPEN_STATUSES.map(() => "?").join(",");
  return {
    total: one("SELECT COUNT(*) AS n FROM reports"),
    open: one(`SELECT COUNT(*) AS n FROM reports WHERE status IN (${openList})`, ...OPEN_STATUSES),
    unread: one(
      `SELECT COUNT(*) AS n FROM reports WHERE read_at IS NULL AND status IN (${openList})`,
      ...OPEN_STATUSES,
    ),
    pending: one("SELECT COUNT(*) AS n FROM reports WHERE triage_status = 'pending'"),
    bugs: one("SELECT COUNT(*) AS n FROM reports WHERE type = 'bug'"),
    feedback: one("SELECT COUNT(*) AS n FROM reports WHERE type = 'feedback'"),
  };
}
