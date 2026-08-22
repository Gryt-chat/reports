import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

import {
  closeDb,
  countReports,
  getReport,
  initDb,
  insertReport,
  listReports,
  setStatus,
  stats,
  type NewReport,
} from "./db.ts";

before(() => initDb(mkdtempSync(join(tmpdir(), "gryt-reports-db-"))));
after(() => closeDb());

let n = 0;

/** Stores a report whose message is unique, since search is what finds it. */
function store(overrides: Partial<NewReport> = {}): string {
  const id = `rep_test_${n++}`;
  insertReport({
    id,
    receivedAt: new Date(Date.now() + n * 1000).toISOString(),
    type: "bug",
    title: null,
    message: `something went wrong ${id}`,
    contact: null,
    appId: "mobile",
    appVersion: "1.4.0",
    appBuild: null,
    appChannel: null,
    appCommit: null,
    installId: null,
    platform: "ios",
    osVersion: "18.2",
    deviceModel: null,
    identitySubject: null,
    ip: "203.0.113.9",
    userAgent: null,
    payload: JSON.stringify({ type: "bug", message: `something went wrong ${id}` }),
    ...overrides,
  });
  return id;
}

test("a report arrives new, and new counts as open", () => {
  const id = store();

  assert.equal(getReport(id)?.status, "new");
  assert.equal(countReports({ shelf: "open", search: id }), 1);
  assert.equal(countReports({ shelf: "closed", search: id }), 0);
});

test("closing one takes it out of the inbox without losing it", () => {
  const id = store();
  setStatus(id, "wont_do", "working as intended", new Date().toISOString());

  const row = getReport(id);
  assert.equal(row?.status, "wont_do");
  assert.equal(row?.status_note, "working as intended");
  assert.ok(row?.status_at);
  assert.equal(row?.message, `something went wrong ${id}`, "closing keeps the report");

  assert.equal(countReports({ shelf: "open", search: id }), 0);
  assert.equal(countReports({ shelf: "closed", search: id }), 1);
  assert.equal(countReports({ status: "wont_do", search: id }), 1);
});

test("a listing leaves the payload behind", () => {
  const id = store();
  const [row] = listReports({ search: id, limit: 1, offset: 0 });

  assert.equal(row.id, id);
  assert.equal("payload" in row, false);
  assert.equal(getReport(id)?.payload.includes(id), true);
});

test("the open count follows what has been decided", () => {
  const before = stats();
  const id = store();
  assert.equal(stats().open, before.open + 1);

  setStatus(id, "resolved", null, new Date().toISOString());
  assert.equal(stats().open, before.open);
  assert.equal(stats().total, before.total + 1);
});

test("a database from before statuses gains them, archived meaning resolved", () => {
  const dir = mkdtempSync(join(tmpdir(), "gryt-reports-old-"));

  // The table as it was when archiving was the only way to close something.
  const old = new DatabaseSync(join(dir, "reports.db"));
  old.exec(`
    CREATE TABLE reports (
      id TEXT PRIMARY KEY, received_at TEXT NOT NULL, type TEXT NOT NULL,
      title TEXT, message TEXT NOT NULL, contact TEXT, app_id TEXT NOT NULL,
      app_version TEXT, app_build TEXT, app_channel TEXT, app_commit TEXT,
      install_id TEXT, platform TEXT, os_version TEXT, device_model TEXT,
      identity_subject TEXT, ip TEXT, user_agent TEXT, payload TEXT NOT NULL,
      triage_status TEXT NOT NULL DEFAULT 'pending', triage_attempts INTEGER NOT NULL DEFAULT 0,
      triage_verdict TEXT, triage_priority TEXT, triage_summary TEXT, triage_area TEXT,
      triage_duplicate_of TEXT, triage_reasoning TEXT, triage_model TEXT, triage_at TEXT,
      triage_error TEXT, read_at TEXT, archived_at TEXT, notified_at TEXT
    )`);
  old.prepare(
    `INSERT INTO reports (id, received_at, type, message, app_id, payload, archived_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    "rep_old",
    new Date().toISOString(),
    "bug",
    "from before",
    "desktop",
    "{}",
    new Date().toISOString(),
  );
  old.close();

  closeDb();
  initDb(dir);

  assert.equal(getReport("rep_old")?.status, "resolved");

  const id = store();
  assert.equal(getReport(id)?.status, "new", "the migrated table still takes new reports");
});
