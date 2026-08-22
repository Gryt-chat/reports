import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { IncomingMessage } from "node:http";

import { addBan, closeDb, initDb } from "./db.ts";
import { clientIp, type HttpError } from "./http.ts";
import {
  assertWithinLimits,
  banFor,
  blockedCount,
  recordBlocked,
  recordSubmission,
  type LimitConfig,
  type Submitter,
} from "./limits.ts";

const limits: LimitConfig = {
  // Off in most of these, so the existing windows can be exercised without
  // every second call tripping the gap instead. Its own test turns it on.
  minIntervalSec: 0,
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

test("a ban is found by any of the submitter's identifiers", () => {
  const nowIso = new Date().toISOString();
  addBan({
    id: "ban_1",
    kind: "install",
    value: "banned-install",
    reason: "spam",
    created_at: nowIso,
    expires_at: null,
  });

  const found = banFor(submitter({ installId: "banned-install" }), nowIso);
  assert.equal(found?.id, "ban_1");

  assert.equal(banFor(submitter({ installId: "some-other-install" }), nowIso), null);
});

test("a swallowed attempt is counted against the ban and the ordinary buckets", () => {
  const nowIso = new Date().toISOString();
  const now = Date.now();
  addBan({
    id: "ban_counted",
    kind: "ip",
    value: "203.0.113.77",
    reason: "spam",
    created_at: nowIso,
    expires_at: null,
  });

  const who = submitter({ ip: "203.0.113.77" });
  const ban = banFor(who, nowIso);
  assert.ok(ban);

  assert.equal(blockedCount("ban_counted", now), 0);
  recordBlocked(who, ban, now);
  recordBlocked(who, ban, now);
  assert.equal(blockedCount("ban_counted", now), 2);

  // And the address has spent budget it would otherwise arrive with, so
  // shedding the ban by changing networks does not also reset the counters.
  assert.throws(
    () => assertWithinLimits(who, limits, now),
    (err: HttpError) => err.code === "rate_limited",
  );
});

test("the minimum gap refuses a second report straight after the first", () => {
  const gapped: LimitConfig = { ...limits, minIntervalSec: 10 };
  const who = submitter({ ip: "203.0.113.90" });
  const now = Date.now();

  assertWithinLimits(who, gapped, now);
  recordSubmission(who, now);

  // Honest, and with the true wait rather than the hourly window's — somebody
  // filing a second genuine report is told ten seconds, not an hour.
  assert.throws(
    () => assertWithinLimits(who, gapped, now + 1000),
    (err: HttpError) => err.code === "rate_limited" && err.extra.retryAfter === 10,
  );

  // And once the gap has passed it lets them through.
  assertWithinLimits(who, gapped, now + 11_000);
});

test("the gap follows the install id across a change of address", () => {
  const gapped: LimitConfig = { ...limits, minIntervalSec: 10 };
  const now = Date.now();

  recordSubmission(submitter({ ip: "192.0.2.201", installId: "gap-install" }), now);

  assert.throws(
    () =>
      assertWithinLimits(
        submitter({ ip: "192.0.2.202", installId: "gap-install" }),
        gapped,
        now + 500,
      ),
    (err: HttpError) => err.code === "rate_limited",
  );
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

  assert.equal(banFor(submitter({ ip: "198.51.100.200" }), nowIso), null);
});

test("a forwarded address is only believed when the proxy is the one asking", () => {
  // The ingest port is published on the machine's network address, so the
  // tunnel is not the only thing that can reach it. Anything else that can
  // will send this header and opt out of every per-address limit and ban.
  const fromStranger = {
    socket: { remoteAddress: "192.0.2.50" },
    headers: { "cf-connecting-ip": "1.2.3.4" },
  } as unknown as IncomingMessage;

  assert.equal(clientIp(fromStranger, true, ["203.0.113.7"]), "192.0.2.50");
  assert.equal(clientIp(fromStranger, true, []), "1.2.3.4", "no list means believe anyone");

  const fromProxy = {
    socket: { remoteAddress: "::ffff:203.0.113.7" },
    headers: { "cf-connecting-ip": "1.2.3.4" },
  } as unknown as IncomingMessage;

  // Same machine whether it introduces itself in v4 or v6 form.
  assert.equal(clientIp(fromProxy, true, ["203.0.113.7"]), "1.2.3.4");

  assert.equal(clientIp(fromProxy, false, []), "::ffff:203.0.113.7", "off means off");
});

test("it names the address it believed, once, and only when a header was sent", () => {
  const named: string[] = [];
  const withHeader = {
    socket: { remoteAddress: "::ffff:203.0.113.7" },
    headers: { "cf-connecting-ip": "1.2.3.4" },
  } as unknown as IncomingMessage;
  const without = {
    socket: { remoteAddress: "::ffff:203.0.113.7" },
    headers: {},
  } as unknown as IncomingMessage;

  clientIp(withHeader, true, [], (p) => named.push(p));
  clientIp(withHeader, true, [], (p) => named.push(p));
  assert.deepEqual(named, ["203.0.113.7", "203.0.113.7"], "the caller decides about repeats");

  // Nothing to pin when nobody claimed to be forwarding anything.
  const quiet: string[] = [];
  clientIp(without, true, [], (p) => quiet.push(p));
  assert.deepEqual(quiet, []);

  // Already pinned, so there is nothing left to say.
  const pinned: string[] = [];
  clientIp(withHeader, true, ["203.0.113.7"], (p) => pinned.push(p));
  assert.deepEqual(pinned, []);
});
