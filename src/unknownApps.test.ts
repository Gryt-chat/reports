import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { closeDb, initDb, listUnknownApps, pruneUnknownApps, recordUnknownApps } from "./db.ts";
import { cleanIds, mayReadUnknownApps, withinLimit } from "./unknownApps.ts";

const WOW = "805124430774272000";
const MODRINTH = "1008017436016410644";
let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "reports-unknown-"));
  initDb(dir);
});
after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("unknown app ids", () => {
  it("keeps only id-shaped strings, once each, at most twenty", () => {
    assert.deepEqual(cleanIds({ ids: [WOW, WOW, "abc", 5, "12", MODRINTH] }), [WOW, MODRINTH]);
    const many = Array.from({ length: 40 }, (_, i) => String(100000000000000000n + BigInt(i)));
    assert.equal(cleanIds({ ids: many }).length, 20);
    assert.throws(() => cleanIds({ nope: 1 }));
  });

  it("lists the most seen first, and forgets what nobody has sent for a while", () => {
    recordUnknownApps([MODRINTH], "2026-10-01T00:00:00.000Z");
    recordUnknownApps([WOW], "2026-10-12T00:00:00.000Z");
    recordUnknownApps([WOW], "2026-10-13T00:00:00.000Z");
    assert.deepEqual(listUnknownApps("2026-09-01T00:00:00.000Z", 10), [WOW, MODRINTH]);
    pruneUnknownApps("2026-10-05T00:00:00.000Z");
    assert.deepEqual(listUnknownApps("2026-09-01T00:00:00.000Z", 10), [WOW]);
  });

  it("limits each address per hour without writing it down", () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) assert.equal(withinLimit("203.0.113.9", now, 3), true);
    assert.equal(withinLimit("203.0.113.9", now, 3), false);
    assert.equal(withinLimit("203.0.113.9", now + 61 * 60 * 1000, 3), true);
  });

  it("is readable only with the token, and by nobody when none is set", () => {
    assert.equal(mayReadUnknownApps("Bearer s3cret-token", "s3cret-token"), true);
    assert.equal(mayReadUnknownApps("Bearer wrong-token1", "s3cret-token"), false);
    assert.equal(mayReadUnknownApps(null, "s3cret-token"), false);
    assert.equal(mayReadUnknownApps("Bearer anything", null), false);
  });
});
