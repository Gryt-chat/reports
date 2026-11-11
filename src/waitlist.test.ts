import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { closeDb, initDb, joinWaitlist, leaveWaitlist, waitlistByPlan, waitlistCount } from "./db.ts";
import { cleanEmail, cleanPlan, hashToken, welcomeMail } from "./waitlist.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "reports-waitlist-"));
  initDb(dir);
});
after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("waitlist", () => {
  it("takes ordinary addresses and lowercases them", () => {
    assert.equal(cleanEmail("  Kari@Example.COM "), "kari@example.com");
    for (const bad of ["", "kari", "kari@", "@example.com", "kari@example", "a b@example.com", "<x>@e.com", 5, null]) {
      assert.equal(cleanEmail(bad), null, String(bad));
    }
    assert.equal(cleanEmail(`${"a".repeat(250)}@e.com`), null);
  });

  it("adds an address once and removes it by its leave token", () => {
    assert.equal(joinWaitlist("kari@example.com", false, "community", hashToken("t1-aaaaaaaaaaaaaaaaaaaa"), "2026-11-11"), true);
    assert.equal(joinWaitlist("kari@example.com", true, null, hashToken("t2-aaaaaaaaaaaaaaaaaaaa"), "2026-11-12"), false);
    assert.equal(waitlistCount(), 1);
    assert.deepEqual(waitlistByPlan(), { community: 1 });
    assert.equal(leaveWaitlist(hashToken("t2-aaaaaaaaaaaaaaaaaaaa")), false);
    assert.equal(leaveWaitlist(hashToken("t1-aaaaaaaaaaaaaaaaaaaa")), true);
    assert.equal(waitlistCount(), 0);
  });

  it("keeps only plans that exist", () => {
    assert.equal(cleanPlan("large"), "large");
    for (const bad of ["Large", "company", "", 3, null, "<b>"]) assert.equal(cleanPlan(bad), null, String(bad));
  });

  it("puts the leave link and the discount in the welcome mail", () => {
    const mail = welcomeMail("kari@example.com", "https://reports.example/v1/waitlist/leave?t=abc");
    assert.match(mail.text, /leave\?t=abc/);
    assert.match(mail.text, /50% off your first three months on Friends or Community/);
    assert.doesNotMatch(mail.text, /signing up,\s*Sivert/);
    assert.match(mail.html ?? "", /href="https:\/\/reports\.example\/v1\/waitlist\/leave\?t=abc"/);
    assert.match(mail.html ?? "", /cid:gryt-mark/);
  });
});
