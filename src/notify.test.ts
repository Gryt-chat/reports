import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";

import type { Config } from "./config.ts";
import { closeDb, getReport, insertReport, initDb, type ReportRow } from "./db.ts";
import { notify } from "./notify.ts";

const DISCORD = "https://discord.test/api/webhooks/1/abc";
const GRYT = "https://gryt.test/api/webhooks/2/def";

before(() => initDb(mkdtempSync(join(tmpdir(), "gryt-reports-notify-"))));
after(() => closeDb());

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

let seq = 0;

function stored(): ReportRow {
  const id = `rep_notify${seq++}`;
  insertReport({
    id,
    receivedAt: new Date().toISOString(),
    type: "bug",
    title: "it broke",
    message: "the call dropped",
    contact: null,
    appId: "desktop",
    appVersion: "1.11.26",
    appBuild: null,
    appChannel: "latest",
    appCommit: null,
    installId: `install-${id}`,
    platform: "macos",
    osVersion: null,
    deviceModel: null,
    identitySubject: null,
    ip: "203.0.113.7",
    userAgent: "Gryt/1.11.26",
    payload: "{}",
  });
  return getReport(id)!;
}

function config(over: Partial<Config> = {}): Config {
  return {
    discordWebhookUrl: DISCORD,
    grytWebhookUrl: GRYT,
    notifyOn: "receive",
    publicUrl: null,
    ...over,
  } as Config;
}

/** Records every post and answers each URL with the status given for it. */
function fakeFetch(status: Record<string, number>) {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: status[url] ?? 500 });
  }) as typeof fetch;
  return posts;
}

test("posts the same report to Discord and to Gryt", async () => {
  const posts = fakeFetch({ [DISCORD]: 204, [GRYT]: 200 });
  const report = stored();

  await notify(config(), report);

  const discord = posts.find((p) => p.url === DISCORD)!.body as { embeds: Record<string, unknown>[] };
  const gryt = posts.find((p) => p.url === GRYT)!.body as { display_name: string; cards: Record<string, unknown>[] };
  assert.equal(gryt.display_name, "Gryt reports");
  assert.equal(gryt.cards[0].title, discord.embeds[0].title);
  assert.equal(gryt.cards[0].description, "the call dropped");
  assert.deepEqual(gryt.cards[0].fields, discord.embeds[0].fields);
  assert.ok(getReport(report.id)!.notified_at);
});

test("leaves out what Gryt would refuse", async () => {
  const posts = fakeFetch({ [DISCORD]: 204, [GRYT]: 200 });

  await notify(config({ publicUrl: null }), stored());

  const card = (posts.find((p) => p.url === GRYT)!.body.cards as Record<string, unknown>[])[0];
  // Discord takes `url: null`, and Gryt answers the same thing with a 400.
  assert.equal("url" in card, false);
});

test("one webhook taking it is enough to count as notified", async () => {
  fakeFetch({ [DISCORD]: 204, [GRYT]: 503 });
  const report = stored();

  await notify(config(), report);

  assert.ok(getReport(report.id)!.notified_at);
});

test("tries again later when neither took it", async () => {
  fakeFetch({ [DISCORD]: 500, [GRYT]: 503 });
  const report = stored();

  await notify(config(), report);

  assert.equal(getReport(report.id)!.notified_at, null);
});

test("posts to Gryt alone when Discord isn't set", async () => {
  const posts = fakeFetch({ [GRYT]: 200 });

  await notify(config({ discordWebhookUrl: null }), stored());

  assert.deepEqual(posts.map((p) => p.url), [GRYT]);
});

test("says nothing with no webhook at all", async () => {
  const posts = fakeFetch({});

  await notify(config({ discordWebhookUrl: null, grytWebhookUrl: null }), stored());

  assert.equal(posts.length, 0);
});
