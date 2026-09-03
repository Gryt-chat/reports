import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Every form on the plain fallback page has to reach a route.
 *
 * The plain pages post to `${base}/reports/<id>/<action>` where `base` is
 * `/admin/plain`, and the route patterns matched `/admin` and `/admin/api`
 * only. So every button on the fallback answered 404 — status, retriage and,
 * once it existed, delete. Nothing failed loudly: the page rendered, the form
 * submitted, and the browser showed a not-found.
 *
 * The fallback is what the inbox is when a dashboard build is broken, which is
 * exactly when nobody is in a position to notice a second thing being broken.
 * So this is a source check rather than a request: it reads the actions off the
 * page markup and asserts a pattern in the same file accepts each one.
 */
const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "admin.ts"),
  "utf8",
);

/** The `${base}/reports/<id>/<action>` targets the plain detail page posts to. */
function formActions(): string[] {
  return [...SOURCE.matchAll(/action="\$\{base\}\/reports\/\$\{esc\(r\.id\)\}\/([a-z]+)"/g)].map(
    (m) => m[1],
  );
}

/** The route patterns, as live regexes. */
function routes(): RegExp[] {
  /* Non-greedy to the first `/);`, because the patterns themselves contain
     brackets — `(?:...)` and the id group — so stopping at the first `)` finds
     a fragment that compiles and matches nothing. */
  return [...SOURCE.matchAll(/path\.match\((\/\^.*?\/)\);/g)].map((m) => {
    const body = m[1].slice(1, m[1].lastIndexOf("/"));
    return new RegExp(body);
  });
}

test("the plain page's forms post to routes that exist", () => {
  const actions = formActions();
  assert.ok(actions.length >= 3, `found only ${actions.length} form actions`);

  const patterns = routes();
  for (const action of actions) {
    const path = `/admin/plain/reports/rep_abc123/${action}`;
    assert.ok(
      patterns.some((pattern) => pattern.test(path)),
      `nothing routes ${path} — the ${action} button on /admin/plain is a 404`,
    );
  }
});

test("the same routes still answer the dashboard and the API", () => {
  const patterns = routes();
  for (const action of formActions()) {
    for (const base of ["/admin", "/admin/api"]) {
      const path = `${base}/reports/rep_abc123/${action}`;
      assert.ok(
        patterns.some((pattern) => pattern.test(path)),
        `nothing routes ${path}`,
      );
    }
  }
});
