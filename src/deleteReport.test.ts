import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  closeDb,
  deleteReport,
  getReport,
  initDb,
  insertReport,
  listDeletions,
  setTask,
} from "./db.ts";

before(() => initDb(mkdtempSync(join(tmpdir(), "gryt-reports-delete-"))));
after(() => closeDb());

let seq = 0;

function stored(): string {
  const id = `rep_del${seq++}`;
  insertReport({
    id,
    receivedAt: new Date().toISOString(),
    type: "bug",
    title: "it broke",
    message: "please forget this",
    contact: "someone@example.com",
    appId: "mobile",
    appVersion: "1.2.3",
    appBuild: "42",
    appChannel: "latest",
    appCommit: "abc1234",
    installId: `install-${id}`,
    platform: "ios",
    osVersion: "26.0",
    deviceModel: "iPhone17,1",
    identitySubject: "thumb-abc",
    ip: "203.0.113.7",
    userAgent: "Gryt/1.2.3",
    payload: "{}",
  });
  return id;
}

test("the report is gone", () => {
  const id = stored();

  assert.notEqual(deleteReport(id, "Sivert", "they asked"), null);
  assert.equal(getReport(id), null);
});

/* A deletion has to be reviewable, or nobody can tell a request that was
   honoured from a row that vanished. */
test("a note says it happened, and who", () => {
  const id = stored();
  deleteReport(id, "Sivert", "they asked");

  const note = listDeletions().find((row) => row.report_id === id);
  assert.equal(note?.deleted_by, "Sivert");
  assert.equal(note?.reason, "they asked");
  assert.ok(note?.deleted_at);
});

/* The note must not become a second copy of what somebody asked us to be rid
   of. If this ever fails, the fix is the schema, not the assertion. */
test("the note holds none of what was written", () => {
  const id = stored();
  deleteReport(id, "Sivert", "they asked");

  const note = listDeletions().find((row) => row.report_id === id);
  const text = JSON.stringify(note);
  assert.ok(!text.includes("please forget this"));
  assert.ok(!text.includes("someone@example.com"));
  assert.ok(!text.includes("203.0.113.7"));
  assert.ok(!text.includes("thumb-abc"));
  assert.ok(!text.includes(`install-${id}`));
});

/* The board entry quotes the report and this service holds no credential that
   could delete it, so the note records where the remaining copy is. Losing
   this would make the deletion look complete when it is not. */
test("the note keeps the task url, so the other copy can be found", () => {
  const id = stored();
  setTask(id, 4242, "https://tasks.sivert.io/tasks/4242");

  const note = deleteReport(id, "Sivert", null);
  assert.equal(note?.task_url, "https://tasks.sivert.io/tasks/4242");
});

test("deleting one that is not there is not a deletion", () => {
  assert.equal(deleteReport("rep_nope", "Sivert", null), null);
  assert.ok(!listDeletions().some((row) => row.report_id === "rep_nope"));
});

/* A second submit of the same form must not read as a second deletion. */
test("deleting twice leaves one note", () => {
  const id = stored();

  assert.notEqual(deleteReport(id, "Sivert", null), null);
  assert.equal(deleteReport(id, "Sivert", null), null);
  assert.equal(listDeletions().filter((row) => row.report_id === id).length, 1);
});
