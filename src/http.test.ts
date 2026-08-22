import assert from "node:assert/strict";
import { test } from "node:test";

import { isAllowedOrigin } from "./http.ts";

const CONFIGURED = ["https://app.gryt.chat", "https://beta.gryt.chat"];

test("a configured origin is allowed", () => {
  assert.equal(isAllowedOrigin("https://app.gryt.chat", CONFIGURED), true);
});

test("an origin nobody configured is refused", () => {
  assert.equal(isAllowedOrigin("https://reports.example.com", CONFIGURED), false);
});

test("the desktop client's loopback origin is allowed on any port", () => {
  // 15738 normally, whatever the OS hands out when that is taken. Both have to
  // work or the app fails for one person in a way nobody can reproduce.
  assert.equal(isAllowedOrigin("http://127.0.0.1:15738", CONFIGURED), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:52341", CONFIGURED), true);
  assert.equal(isAllowedOrigin("http://localhost:3666", CONFIGURED), true);
  assert.equal(isAllowedOrigin("http://[::1]:15738", CONFIGURED), true);
});

test("a hostname that merely contains localhost is refused", () => {
  // The whole check is worthless if "localhost.attacker.example" passes it.
  assert.equal(isAllowedOrigin("https://localhost.attacker.example", CONFIGURED), false);
  assert.equal(isAllowedOrigin("https://not-localhost", CONFIGURED), false);
  assert.equal(isAllowedOrigin("https://127.0.0.1.attacker.example", CONFIGURED), false);
});

test("a null origin is refused", () => {
  // What a sandboxed iframe and a file:// page send. Neither is loopback and
  // neither is on the list.
  assert.equal(isAllowedOrigin("null", CONFIGURED), false);
});

test("a non-http scheme is refused even on loopback", () => {
  assert.equal(isAllowedOrigin("ws://127.0.0.1:15738", CONFIGURED), false);
  assert.equal(isAllowedOrigin("file://127.0.0.1", CONFIGURED), false);
});

test("a wildcard allows anything", () => {
  assert.equal(isAllowedOrigin("https://reports.example.com", ["*"]), true);
});
