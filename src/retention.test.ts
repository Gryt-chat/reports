import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { Config } from "./config.ts";
import {
  closeDb,
  getReport,
  initDb,
  insertReport,
  saveTriage,
  scrubReportIdentifiers,
} from "./db.ts";
import { scrubOldIdentifiers } from "./retention.ts";
import { noiseBanFor } from "./triage.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const AUTO_BAN = { threshold: 3, windowHours: 24, days: 7 };

before(() => initDb(mkdtempSync(join(tmpdir(), "gryt-reports-retention-"))));
after(() => closeDb());

let seq = 0;

/** A stored report, sent `ageDays` ago by somebody we wrote down. */
function stored(ageDays: number, verdict: string | null = null): string {
  const id = `rep_ret${seq++}`;
  insertReport({
    id,
    receivedAt: new Date(NOW - ageDays * DAY).toISOString(),
    type: "bug",
    title: "it broke",
    message: "the thing did not work",
    contact: "someone@example.com",
    appId: "mobile",
    appVersion: "1.2.3",
    appBuild: "42",
    appChannel: "latest",
    appCommit: "abc1234",
    installId: `install-${id}`,
    platform: "ios",
    osVersion: "26.0",
    deviceModel: "iPhone17,1",
    identitySubject: "thumb-abc",
    ip: "203.0.113.7",
    userAgent: "Gryt/1.2.3 (iOS 26.0)",
    payload: "{}",
  });
  if (verdict) {
    saveTriage(
      id,
      {
        verdict,
        priority: "low",
        summary: "junk",
        area: "unknown",
        duplicateOf: null,
        reasoning: "because",
        model: "test",
      },
      new Date(NOW - ageDays * DAY).toISOString(),
    );
  }
  return id;
}

/** Only the field the code under test reads. */
function config(identifierDays: number): Config {
  return { retention: { identifierDays } } as unknown as Config;
}

/* Every test in this file shares one database, so a count assertion is only
   about this test's row if whatever the last one left behind is already
   scrubbed. Clearing the decks first is what makes these independent of the
   order they run in. */
function clearDecks(): void {
  scrubOldIdentifiers(config(2), NOW);
}

test("forgets who sent a report past the window", () => {
  clearDecks();
  const id = stored(3);

  assert.equal(scrubOldIdentifiers(config(2), NOW), 1);

  const row = getReport(id);
  assert.equal(row?.ip, null);
  assert.equal(row?.identity_subject, null);
});

test("keeps what the report is for", () => {
  const id = stored(3);
  scrubOldIdentifiers(config(2), NOW);

  const row = getReport(id);
  assert.equal(row?.message, "the thing did not work");
  assert.equal(row?.title, "it broke");
  assert.equal(row?.contact, "someone@example.com");
  assert.equal(row?.app_version, "1.2.3");
  assert.equal(row?.platform, "ios");
  assert.equal(row?.device_model, "iPhone17,1");
});

/* Neither says who or where. The install id is meaningless outside this
   database and is what shows two reports came from the same copy of the app;
   the user-agent is the app version and the OS, which the row already has. */
test("keeps the install id and the user-agent", () => {
  const id = stored(400);
  scrubOldIdentifiers(config(2), NOW);

  const row = getReport(id);
  assert.equal(row?.install_id, `install-${id}`);
  assert.equal(row?.user_agent, "Gryt/1.2.3 (iOS 26.0)");
});

test("leaves a report inside the window alone", () => {
  clearDecks();
  const id = stored(1);

  assert.equal(scrubOldIdentifiers(config(2), NOW), 0);
  assert.equal(getReport(id)?.ip, "203.0.113.7");
});

/* The whole reason the columns are kept at all. Two days has to leave the
   auto-ban's own window — a day — intact, or the scrub has broken the only
   thing that reads them. */
test("the noise auto-ban still fires inside the window", () => {
  clearDecks();
  const ids = [stored(0, "noise"), stored(0, "noise"), stored(0, "noise")];

  scrubOldIdentifiers(config(2), NOW);

  const ban = noiseBanFor(getReport(ids[2])!, AUTO_BAN, NOW);
  assert.equal(ban?.kind, "subject");
  assert.equal(ban?.value, "thumb-abc");
});

/* Without the null checks in the WHERE clause this rewrites every old row on
   every pass, for the life of the database. */
test("does not rewrite a report it has already scrubbed", () => {
  clearDecks();
  stored(3);

  assert.equal(scrubOldIdentifiers(config(2), NOW), 1);
  assert.equal(scrubOldIdentifiers(config(2), NOW), 0);
});

test("zero days keeps everything, which is what it did before", () => {
  const id = stored(400);

  assert.equal(scrubOldIdentifiers(config(0), NOW), 0);
  assert.equal(getReport(id)?.ip, "203.0.113.7");
});

/* The column is TEXT holding an ISO timestamp, so the comparison is a string
   comparison. It only orders correctly because every value is the same shape
   and the same zone — a receivedAt written any other way would sort wrong and
   scrub the wrong rows. */
test("compares timestamps as ISO strings", () => {
  const id = stored(3); // 2026-08-31T12:00Z

  scrubReportIdentifiers("2026-08-30T00:00:00.000Z");
  assert.equal(getReport(id)?.ip, "203.0.113.7");

  scrubReportIdentifiers("2026-09-01T00:00:00.000Z");
  assert.equal(getReport(id)?.ip, null);
});
