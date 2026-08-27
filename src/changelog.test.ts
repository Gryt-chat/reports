import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  compareVersions,
  decide,
  knownVersions,
  parseDraft,
  publicDocument,
  receiveDraft,
  writePublicFile,
} from "./changelog.ts";
import type { Config } from "./config.ts";
import { closeDb, getChangelogDraft, initDb, listChangelogDrafts } from "./db.ts";
import { HttpError } from "./http.ts";

let dataDir = "";

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), "gryt-reports-changelog-"));
  initDb(dataDir);
});
after(() => closeDb());

let n = 0;

/** A draft that passes, so a test can change the one field it is about. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  n += 1;
  return {
    version: `1.6.${n}`,
    date: "2026-08-27",
    channel: "latest",
    headline: "Screen sharing stops dropping when the network changes",
    intro: ["A small release, and mostly about one thing."],
    sections: [
      { heading: "Screen sharing survives a network change", body: ["It used to stop."] },
    ],
    recap: [{ group: "Voice", items: ["Screen sharing survives a network change"] }],
    source: { since: "1.6.42", commits: 7, model: "qwen3:32b" },
    commits: [
      { component: "client", commits: [{ subject: "Reconnect the screen share", body: "" }] },
    ],
    ...overrides,
  };
}

function refuses(raw: Record<string, unknown>, because: string): void {
  assert.throws(
    () => parseDraft(raw),
    (err: unknown) => err instanceof HttpError && err.status === 400,
    because,
  );
}

test("a well-formed draft survives the round trip", () => {
  const draft = parseDraft(body({ version: "1.6.900" }));
  assert.equal(draft.version, "1.6.900");
  assert.equal(draft.intro.length, 1);
  assert.equal(draft.sections[0].body[0], "It used to stop.");
  assert.equal(draft.source?.model, "qwen3:32b");
  assert.equal(draft.commits[0].component, "client");
});

test("shape is refused rather than repaired", () => {
  refuses(body({ version: "not-a-version" }), "a version that is not one");
  refuses(body({ date: "27-08-2026" }), "a date in the wrong order");
  refuses(body({ channel: "stable" }), "a channel that does not exist");
  refuses(body({ headline: "   " }), "an empty headline");
  refuses(body({ sections: "a paragraph" }), "sections that are not an array");
  refuses(body({ sections: [{ heading: "One", body: "not an array" }] }), "a string body");
  refuses(body({ sections: [{ heading: "One", body: [42] }] }), "a body of numbers");
  refuses(body({ recap: [{ group: "Voice", items: [{}] }] }), "recap items that are objects");
});

test("an over-long paragraph is cut, not refused", () => {
  const draft = parseDraft(body({ intro: ["x".repeat(9000)] }));
  assert.equal(draft.intro[0].length, 4000);
});

test("a missing intro or recap is empty rather than fatal", () => {
  const draft = parseDraft(body({ intro: undefined, recap: undefined }));
  assert.deepEqual(draft.intro, []);
  assert.deepEqual(draft.recap, []);
});

test("a malformed commit range is dropped and the note kept", () => {
  const draft = parseDraft(body({ commits: "the whole log" }));
  assert.deepEqual(draft.commits, []);
  assert.equal(draft.headline.length > 0, true);
});

test("posting the same version twice does nothing the second time", () => {
  const version = "1.7.0";
  const first = receiveDraft(parseDraft(body({ version })), {
    force: false,
    now: new Date().toISOString(),
  });
  const second = receiveDraft(parseDraft(body({ version, headline: "Something else" })), {
    force: false,
    now: new Date().toISOString(),
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(getChangelogDraft(first.id)?.headline.startsWith("Screen sharing"), true);
});

test("forcing replaces the live draft and keeps the old one", () => {
  const version = "1.7.1";
  const first = receiveDraft(parseDraft(body({ version })), {
    force: false,
    now: new Date().toISOString(),
  });
  const second = receiveDraft(parseDraft(body({ version, headline: "A second attempt" })), {
    force: true,
    now: new Date().toISOString(),
  });

  assert.notEqual(second.id, first.id);
  assert.equal(getChangelogDraft(first.id)?.status, "superseded");
  assert.equal(getChangelogDraft(second.id)?.status, "draft");
});

test("a version the drafter has already had a go at is known, once", () => {
  const version = "1.7.2";
  receiveDraft(parseDraft(body({ version })), { force: false, now: new Date().toISOString() });
  receiveDraft(parseDraft(body({ version })), { force: true, now: new Date().toISOString() });

  const versions = knownVersions();
  assert.equal(versions.filter((v) => v === version).length, 1);
});

test("a rejected version is not known, so the drafter has another go", () => {
  const version = "1.7.7";
  const entry = receiveDraft(parseDraft(body({ version })), {
    force: false,
    now: new Date().toISOString(),
  });
  assert.equal(knownVersions().includes(version), true);

  decide(entry.id, "rejected", null, "Sivert", new Date().toISOString());

  /* Rejecting is how you ask for another draft, so the drafter has to stop
     seeing this version as done. It skipped rejected versions for a while,
     which made Reject mean "never again" without anything saying so. */
  assert.equal(knownVersions().includes(version), false);
});

test("a published version stays known, so it is not drafted over", () => {
  const version = "1.7.8";
  const entry = receiveDraft(parseDraft(body({ version })), {
    force: false,
    now: new Date().toISOString(),
  });
  decide(entry.id, "published", null, "Sivert", new Date().toISOString());
  assert.equal(knownVersions().includes(version), true);
});

test("publishing and rejecting record who and when", () => {
  const published = receiveDraft(parseDraft(body({ version: "1.7.3" })), {
    force: false,
    now: new Date().toISOString(),
  });
  const rejected = receiveDraft(parseDraft(body({ version: "1.7.4" })), {
    force: false,
    now: new Date().toISOString(),
  });

  decide(published.id, "published", null, "Sivert", "2026-08-27T10:00:00.000Z");
  decide(rejected.id, "rejected", "Invented a keychain section", "Sivert", "2026-08-27T10:01:00.000Z");

  assert.equal(getChangelogDraft(published.id)?.status, "published");
  assert.equal(getChangelogDraft(rejected.id)?.decided_by, "Sivert");
  // The refusal keeps its text. Reading one is how the first fabricated draft
  // was diagnosed, so a rejection that threw the note away would take that with it.
  assert.equal(getChangelogDraft(rejected.id)?.headline.startsWith("Screen sharing"), true);
  assert.equal(getChangelogDraft(rejected.id)?.note, "Invented a keychain section");
});

test("a rejected draft cannot be published afterwards", () => {
  const entry = receiveDraft(parseDraft(body({ version: "1.7.5" })), {
    force: false,
    now: new Date().toISOString(),
  });
  decide(entry.id, "rejected", null, "Sivert", new Date().toISOString());

  assert.throws(
    () => decide(entry.id, "published", null, "Sivert", new Date().toISOString()),
    (err: unknown) => err instanceof HttpError && err.status === 409,
  );
});

test("rejecting frees the version for another draft", () => {
  const version = "1.7.6";
  const first = receiveDraft(parseDraft(body({ version })), {
    force: false,
    now: new Date().toISOString(),
  });
  decide(first.id, "rejected", null, "Sivert", new Date().toISOString());

  const second = receiveDraft(parseDraft(body({ version, headline: "Another go" })), {
    force: false,
    now: new Date().toISOString(),
  });
  assert.equal(second.created, true);
  assert.notEqual(second.id, first.id);
});

test("the file carries drafts and published notes, and never the commits", () => {
  const version = "1.8.0";
  const entry = receiveDraft(parseDraft(body({ version })), {
    force: false,
    now: new Date().toISOString(),
  });
  decide(entry.id, "published", null, "Sivert", new Date().toISOString());

  const doc = publicDocument("2026-08-27T10:00:00.000Z");
  const published = doc.entries.find((e) => e.version === version);

  assert.equal(published?.status, "published");
  assert.equal(Object.hasOwn(published ?? {}, "commits"), false);
  assert.equal(Object.hasOwn(published ?? {}, "decidedBy"), false);
  assert.equal(Object.hasOwn(published ?? {}, "note"), false);
  assert.equal(doc.entries.some((e) => e.status === "draft"), true);
});

test("a rejected note is not in the file at all", () => {
  const version = "1.8.1";
  const entry = receiveDraft(parseDraft(body({ version })), {
    force: false,
    now: new Date().toISOString(),
  });
  decide(entry.id, "rejected", null, "Sivert", new Date().toISOString());

  const doc = publicDocument("2026-08-27T10:00:00.000Z");
  assert.equal(doc.entries.some((e) => e.version === version), false);
  // Still readable in the inbox, which is the point of keeping it.
  assert.equal(listChangelogDrafts("rejected").some((r) => r.version === version), true);
});

test("the file is written where it was asked for, and not at all without a path", () => {
  const path = join(dataDir, "release-notes", "changelog.json");
  const config = { changelog: { key: null, file: path } } as Config;

  assert.equal(writePublicFile(config, "2026-08-27T10:00:00.000Z"), true);
  const doc = JSON.parse(readFileSync(path, "utf8")) as { entries: { version: string }[] };
  assert.equal(doc.entries.length > 0, true);

  const off = { changelog: { key: null, file: null } } as Config;
  assert.equal(writePublicFile(off), false);
});

test("versions sort by number, not by string or by date", () => {
  const sorted = ["1.6.10", "1.6.9", "1.10.0", "1.6.43"].sort(compareVersions);
  assert.deepEqual(sorted, ["1.6.9", "1.6.10", "1.6.43", "1.10.0"]);
});
