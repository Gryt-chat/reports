import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  addBan,
  closeDb,
  getReport,
  initDb,
  insertReport,
  saveTriage,
  type ReportRow,
} from "./db.ts";
import { noiseBanFor } from "./triage.ts";

const AUTO_BAN = { threshold: 3, windowHours: 24, days: 7 };

before(() => initDb(mkdtempSync(join(tmpdir(), "gryt-reports-triage-"))));
after(() => closeDb());

let seq = 0;

/** A stored, triaged report. Returns the row as the triage pass would see it. */
function stored(
  verdict: string,
  who: { ip?: string; subject?: string | null },
  at = Date.now(),
): ReportRow {
  const id = `rep_test${seq++}`;
  const receivedAt = new Date(at).toISOString();

  insertReport({
    id,
    receivedAt,
    type: "bug",
    title: null,
    message: "whatever",
    contact: null,
    appId: "mobile",
    appVersion: null,
    appBuild: null,
    appChannel: null,
    appCommit: null,
    installId: null,
    platform: null,
    osVersion: null,
    deviceModel: null,
    identitySubject: who.subject ?? null,
    ip: who.ip ?? "203.0.113.1",
    userAgent: null,
    payload: "{}",
  });

  saveTriage(
    id,
    {
      verdict,
      priority: "low",
      summary: "s",
      area: "unknown",
      duplicateOf: null,
      reasoning: "r",
      model: "test",
    },
    receivedAt,
  );

  return getReport(id) as ReportRow;
}

test("three noise reports from one address earns a ban", () => {
  const ip = "198.51.100.10";
  stored("noise", { ip });
  stored("noise", { ip });
  const third = stored("noise", { ip });

  const ban = noiseBanFor(third, AUTO_BAN, Date.now());
  assert.ok(ban, "expected a ban");
  assert.equal(ban.kind, "ip");
  assert.equal(ban.value, ip);
  assert.match(ban.reason, /^auto: 3 noise reports in 24h \(rep_/);
  assert.ok(ban.expires_at, "an auto ban has to expire");
});

test("two is not enough", () => {
  const ip = "198.51.100.11";
  stored("noise", { ip });
  const second = stored("noise", { ip });

  assert.equal(noiseBanFor(second, AUTO_BAN, Date.now()), null);
});

test("not_a_bug never counts, however many arrive", () => {
  // A feature request and a support question both land here. Somebody who
  // sends five is the most engaged person using Gryt, and banning them is the
  // opposite of what this inbox is for.
  const ip = "198.51.100.12";
  let last = stored("not_a_bug", { ip });
  for (let i = 0; i < 4; i++) last = stored("not_a_bug", { ip });

  assert.equal(noiseBanFor(last, AUTO_BAN, Date.now()), null);
});

test("neither does needs_info, which is a real report missing one detail", () => {
  const ip = "198.51.100.13";
  let last = stored("needs_info", { ip });
  for (let i = 0; i < 4; i++) last = stored("needs_info", { ip });

  assert.equal(noiseBanFor(last, AUTO_BAN, Date.now()), null);
});

test("the subject wins over the address, so changing networks does not help", () => {
  const subject = "thumbprint-abc";
  stored("noise", { ip: "192.0.2.1", subject });
  stored("noise", { ip: "192.0.2.2", subject });
  const third = stored("noise", { ip: "192.0.2.3", subject });

  const ban = noiseBanFor(third, AUTO_BAN, Date.now());
  assert.ok(ban);
  assert.equal(ban.kind, "subject");
  assert.equal(ban.value, subject);
});

test("noise from more than a day ago has aged out", () => {
  const ip = "198.51.100.14";
  const old = Date.now() - 40 * 60 * 60 * 1000;
  stored("noise", { ip }, old);
  stored("noise", { ip }, old);
  const now = stored("noise", { ip });

  assert.equal(noiseBanFor(now, AUTO_BAN, Date.now()), null);
});

test("an existing ban is not stacked with a fresh expiry", () => {
  const ip = "198.51.100.15";
  const nowIso = new Date().toISOString();
  addBan({
    id: "ban_existing",
    kind: "ip",
    value: ip,
    reason: "by hand",
    created_at: nowIso,
    expires_at: null,
  });

  stored("noise", { ip });
  stored("noise", { ip });
  const third = stored("noise", { ip });

  assert.equal(noiseBanFor(third, AUTO_BAN, Date.now()), null);
});

test("a threshold of zero turns the whole thing off", () => {
  const ip = "198.51.100.16";
  stored("noise", { ip });
  stored("noise", { ip });
  const third = stored("noise", { ip });

  assert.equal(noiseBanFor(third, { ...AUTO_BAN, threshold: 0 }, Date.now()), null);
});
