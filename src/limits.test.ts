import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { addBan, closeDb, initDb } from "./db.ts";
import type { HttpError } from "./http.ts";
import {
  assertNotBanned,
  assertWithinLimits,
  recordSubmission,
  type LimitConfig,
  type Submitter,
} from "./limits.ts";

const limits: LimitConfig = {
  perMinute: 2,
  perHourPerIp: 3,
  perHourPerInstall: 3,
  perDayPerIp: 4,
};

before(() => initDb(mkdtempSync(join(tmpdir(), "gryt-reports-limits-"))));
after(() => closeDb());

function submitter(overrides: Partial<Submitter> = {}): Submitter {
  return {
    ip: "198.51.100.7",
    appId: "mobile",
    installId: null,
    subject: null,
    ...overrides,
  };
}

test("lets a normal amount through and stops the rest", () => {
  const who = submitter({ ip: "203.0.113.1" });
  const now = Date.now();

  for (let i = 0; i < limits.perMinute; i++) {
    assertWithinLimits(who, limits, now);
    recordSubmission(who, now);
  }

  assert.throws(
    () => assertWithinLimits(who, limits, now),
    (err: HttpError) => err.status === 429 && err.extra.retryAfter === 60,
  );
});

test("an hour later the minute window has moved on", () => {
  const who = submitter({ ip: "203.0.113.2" });
  const now = Date.now();

  recordSubmission(who, now - 90 * 60 * 1000);
  recordSubmission(who, now - 80 * 60 * 1000);
  recordSubmission(who, now - 70 * 60 * 1000);

  assertWithinLimits(who, limits, now);
});

test("an install id is counted even when the address changes", () => {
  const now = Date.now();
  const install = "install-abc";

  for (let i = 0; i < limits.perHourPerInstall; i++) {
    recordSubmission(submitter({ ip: `192.0.2.${i}`, installId: install }), now);
  }

  assert.throws(
    () => assertWithinLimits(submitter({ ip: "192.0.2.99", installId: install }), limits, now),
    (err: HttpError) => err.code === "rate_limited",
  );
});

test("a ban stops a submitter, and says nothing about which one hit", () => {
  const nowIso = new Date().toISOString();
  addBan({
    id: "ban_1",
    kind: "install",
    value: "banned-install",
    reason: "spam",
    created_at: nowIso,
    expires_at: null,
  });

  assert.throws(
    () => assertNotBanned(submitter({ installId: "banned-install" }), nowIso),
    (err: HttpError) => err.status === 403 && !err.message.includes("spam"),
  );

  assertNotBanned(submitter({ installId: "some-other-install" }), nowIso);
});

test("an expired ban is not a ban", () => {
  const nowIso = new Date().toISOString();
  addBan({
    id: "ban_2",
    kind: "ip",
    value: "198.51.100.200",
    reason: "was rude",
    created_at: new Date(Date.now() - 86_400_000).toISOString(),
    expires_at: new Date(Date.now() - 3600_000).toISOString(),
  });

  assertNotBanned(submitter({ ip: "198.51.100.200" }), nowIso);
});
