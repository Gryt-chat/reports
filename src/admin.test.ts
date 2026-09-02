import assert from "node:assert/strict";
import { test } from "node:test";

import { signOutCookies } from "./admin.ts";

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
