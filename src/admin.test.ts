import assert from "node:assert/strict";
import { test } from "node:test";

import { draftListPage, draftPage, signOutCookies } from "./admin.ts";
import type { ChangelogEntry } from "./changelog.ts";

/** The attributes each cookie is set with, from the handlers that set them. */
const SET_WITH = {
  gryt_reports_session: { sameSite: "Lax", path: "/admin" },
  gryt_reports_admin: { sameSite: "Strict", path: "/admin" },
  gryt_reports_login: { sameSite: "Lax", path: "/admin" },
};

function attributes(header: string) {
  const [pair, ...rest] = header.split(";").map((part) => part.trim());
  const name = pair.split("=")[0];
  const sameSite = rest.find((part) => part.startsWith("SameSite="))?.slice(9);
  const path = rest.find((part) => part.startsWith("Path="))?.slice(5);
  return { name, sameSite, path, value: pair.split("=")[1], rest };
}

test("signing out clears every cookie that can hold a session", () => {
  // Both the Keycloak session cookie and the static token cookie authorise on
  // their own. Clearing one and not the other leaves the inbox open, which is
  // what GRYT-539 was.
  const names = signOutCookies(false).map((header) => attributes(header).name);
  assert.deepEqual(names.sort(), Object.keys(SET_WITH).sort());
});

test("each clear matches the Path and SameSite it was set with", () => {
  // A Set-Cookie that does not match on Path deletes nothing, and the response
  // is indistinguishable from one that worked.
  for (const header of signOutCookies(false)) {
    const got = attributes(header);
    const want = SET_WITH[got.name as keyof typeof SET_WITH];
    assert.ok(want, `unexpected cookie ${got.name}`);
    assert.equal(got.path, want.path, `${got.name} Path`);
    assert.equal(got.sameSite, want.sameSite, `${got.name} SameSite`);
    assert.equal(got.value, "", `${got.name} still carries a value`);
    assert.ok(got.rest.includes("Max-Age=0"), `${got.name} does not expire`);
    assert.ok(got.rest.includes("HttpOnly"), `${got.name} is not HttpOnly`);
  }
});

test("Secure rides along on the session cookie over https", () => {
  const secure = signOutCookies(true);
  const session = secure.find((header) => header.startsWith("gryt_reports_session="));
  assert.ok(session?.includes("Secure"));

  // The token cookie is set without it, so clearing it must not add one.
  const token = secure.find((header) => header.startsWith("gryt_reports_admin="));
  assert.ok(token && !token.includes("Secure"));
});

/* ── The plain pages for drafted release notes ───────────────────────────
   These hand-write HTML around prose a model produced and commit messages out
   of the repository. The dashboard escapes by construction because it is React;
   this is the copy that has to remember, so it gets a test. */

function draft(overrides: Partial<ChangelogEntry> = {}): ChangelogEntry {
  return {
    id: "cl_test",
    version: "1.6.43",
    date: "2026-08-24",
    channel: "latest",
    headline: "Every owl was redrawn",
    intro: ["The generated avatars have been redrawn."],
    sections: [{ heading: "The owls changed", body: ["They look different now."] }],
    recap: [{ group: "Avatars and images", items: ["Generated owls redrawn"] }],
    source: { since: "1.6.42", commits: 7, model: "qwen3:32b" },
    commits: [
      { component: "client", commits: [{ subject: "Redraw the owl", body: "A body." }] },
    ],
    status: "draft",
    draftedAt: "2026-08-27T09:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
    note: null,
    ...overrides,
  };
}

const ATTACK = '</p><script>alert(1)</script><p x="';

test("a draft page escapes every field a model or a commit can reach", () => {
  const html = draftPage(
    draft({
      headline: ATTACK,
      intro: [ATTACK],
      sections: [{ heading: ATTACK, body: [ATTACK] }],
      recap: [{ group: ATTACK, items: [ATTACK] }],
      note: ATTACK,
      version: "1.6.43",
      source: { since: ATTACK, model: ATTACK },
      commits: [{ component: ATTACK, commits: [{ subject: ATTACK, body: ATTACK }] }],
    }),
    { kind: "token" },
  );

  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("alert(1)"), true, "the text itself should still be there");
});

test("a draft list escapes the headline and the version", () => {
  const html = draftListPage([draft({ headline: ATTACK })], "draft", { kind: "token" });
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("alert(1)"), true);
});

test("only a waiting draft is offered a decision", () => {
  const waiting = draftPage(draft(), { kind: "token" });
  assert.equal(waiting.includes("/publish"), true);
  assert.equal(waiting.includes("/reject"), true);

  for (const status of ["published", "rejected", "superseded"] as const) {
    const settled = draftPage(draft({ status }), { kind: "token" });
    assert.equal(settled.includes("/publish"), false, `${status} offers Publish`);
    assert.equal(settled.includes("/reject"), false, `${status} offers Reject`);
  }
});

test("a draft with no commit range says so rather than showing an empty list", () => {
  const html = draftPage(draft({ commits: [] }), { kind: "token" });
  assert.equal(html.includes("nothing here to check it against"), true);
});
