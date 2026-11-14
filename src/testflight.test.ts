import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { loadConfig } from "./config.ts";
import { closeDb, getReport, initDb } from "./db.ts";
import { TestflightPoller } from "./testflight.ts";

process.env.REPORTS_ALLOW_UNKEYED = "true";
const dir = mkdtempSync(join(tmpdir(), "gryt-reports-tf-"));
before(() => initDb(dir));
after(() => closeDb());

const keyPath = join(dir, "key.p8");
writeFileSync(
  keyPath,
  generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }),
);

const LOG = "Version:             0.1.1 (127)\nException Type:  EXC_CRASH (SIGABRT)\nThread 0 Crashed:\n0 hermesvm";

function fakeApple(calls: string[]): typeof fetch {
  return (async (url: string | URL) => {
    const path = String(url).replace("https://api.appstoreconnect.apple.com", "");
    calls.push(path);
    const body = path.includes("CrashSubmissions?")
      ? { data: [{ id: "c1", attributes: { comment: "zoomed out, it crashed", deviceModel: "iPhone15_3", osVersion: "27.0", devicePlatform: "IOS", createdDate: "2026-11-14T22:39:21.049Z" } }] }
      : path.endsWith("/crashLog")
        ? { data: { attributes: { logText: LOG } } }
        : { data: [{ id: "s1", attributes: { comment: "button is cut off", screenshots: [{ url: "https://example.com/a.png" }] } }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

test("TestFlight crashes and screenshots land once, crash log included", async () => {
  const config = { ...loadConfig(), asc: { keyId: "K", issuerId: "I", keyPath, appId: "1", pollMinutes: 15 } };
  const calls: string[] = [];
  const seen: string[] = [];
  const poller = new TestflightPoller(config, (id) => seen.push(id), fakeApple(calls));

  assert.equal(await poller.poll(), 2);
  assert.deepEqual(seen, ["tf_c1", "tf_s1"]);

  const crash = getReport("tf_c1");
  assert.equal(crash?.type, "bug");
  assert.equal(crash?.message, "zoomed out, it crashed");
  assert.equal(crash?.app_build, "127");
  assert.equal(crash?.platform, "ios");
  const payload = JSON.parse(crash!.payload);
  assert.equal(payload.error.message, "EXC_CRASH (SIGABRT)");
  assert.ok(payload.logs.some((l: string) => l.includes("hermesvm")));
  assert.equal(getReport("tf_s1")?.type, "feedback");

  assert.equal(await poller.poll(), 0, "a second poll adds nothing");
  assert.equal(calls.filter((c) => c.endsWith("/crashLog")).length, 1);
});

test("a failing Apple answer is logged, not thrown", async () => {
  const config = { ...loadConfig(), asc: { keyId: "K", issuerId: "I", keyPath, appId: "1", pollMinutes: 15 } };
  const poller = new TestflightPoller(config, () => {}, (async () => new Response("no", { status: 401 })) as typeof fetch);
  assert.equal(await poller.poll(), 0);
});
