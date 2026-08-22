import assert from "node:assert/strict";
import { test } from "node:test";

import { HttpError } from "./http.ts";
import { normaliseReport, type Limits } from "./report.ts";

const limits: Limits = {
  maxMessageChars: 100,
  maxLogLines: 3,
  maxLogLineChars: 20,
  maxExtraChars: 100,
};

test("takes the two fields it needs and fills in the rest", () => {
  const report = normaliseReport({ type: "bug", message: "  it crashed  " }, "mobile", limits);

  assert.equal(report.type, "bug");
  assert.equal(report.message, "it crashed");
  assert.equal(report.app.id, "mobile");
  assert.equal(report.app.version, null);
  assert.deepEqual(report.logs, []);
  assert.equal(report.error, null);
});

test("refuses a report with no type or no message", () => {
  assert.throws(
    () => normaliseReport({ message: "hi" }, "mobile", limits),
    (err: HttpError) => err.status === 400 && err.code === "invalid_type",
  );
  assert.throws(
    () => normaliseReport({ type: "bug", message: "   " }, "mobile", limits),
    (err: HttpError) => err.code === "empty_message",
  );
  assert.throws(
    () => normaliseReport("not an object", "mobile", limits),
    (err: HttpError) => err.code === "invalid_body",
  );
});

test("truncates rather than rejecting, so a long report still arrives", () => {
  const report = normaliseReport(
    { type: "feedback", message: "x".repeat(500) },
    "desktop",
    limits,
  );

  assert.equal(report.message.length, limits.maxMessageChars + 1); // the ellipsis
  assert.ok(report.message.endsWith("…"));
});

test("keeps the tail of the log, bounded both ways", () => {
  const report = normaliseReport(
    {
      type: "bug",
      message: "voice dropped",
      logs: ["one", "two", "three", "four", "y".repeat(50)],
    },
    "mobile",
    limits,
  );

  assert.equal(report.logs.length, 3);
  assert.equal(report.logs[0], "three");
  assert.equal(report.logs[2].length, limits.maxLogLineChars + 1);
});

test("drops control characters but keeps newlines", () => {
  const report = normaliseReport(
    { type: "bug", message: "line one\nline two\u001b[31m\u0000" },
    "mobile",
    limits,
  );

  assert.equal(report.message, "line one\nline two[31m");
});

test("the app id comes from the header, never from the body", () => {
  const report = normaliseReport(
    { type: "bug", message: "hi", app: { id: "pretend-i-am-desktop", version: "1.2.3" } },
    "mobile",
    limits,
  );

  assert.equal(report.app.id, "mobile");
  assert.equal(report.app.version, "1.2.3");
});

test("collects the diagnostics a bug report is useless without", () => {
  const report = normaliseReport(
    {
      type: "bug",
      message: "camera is upside down",
      app: { version: "1.4.0", build: "412", channel: "beta", installId: "abc" },
      device: {
        platform: "IOS",
        osVersion: "18.2",
        model: "iPhone15,3",
        screen: { width: "393", height: 852, scale: 3 },
        memoryMb: 6144.456,
      },
      runtime: { engine: "hermes", reactNativeVersion: "0.79.1" },
      context: { route: "/channel/voice", voiceActive: true, permissions: { camera: "granted" } },
      error: { name: "TypeError", message: "undefined is not a function" },
    },
    "mobile",
    limits,
  );

  assert.equal(report.device.platform, "ios");
  assert.equal(report.device.screen?.width, 393);
  assert.equal(report.device.memoryMb, 6144.46);
  assert.equal(report.context.voiceActive, true);
  assert.deepEqual(report.context.permissions, { camera: "granted" });
  assert.equal(report.error?.name, "TypeError");
  assert.equal(report.runtime.reactNativeVersion, "0.79.1");
});

test("keeps small extras and drops oversized ones", () => {
  const small = normaliseReport(
    { type: "feedback", message: "nice", extra: { theme: "dark" } },
    "web",
    limits,
  );
  assert.deepEqual(small.extra, { theme: "dark" });

  const big = normaliseReport(
    { type: "feedback", message: "nice", extra: { blob: "z".repeat(500) } },
    "web",
    limits,
  );
  assert.equal(big.extra, null);
});
