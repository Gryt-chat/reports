import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { loadConfig } from "./config.ts";

const NAMES = ["REPORTS_OLLAMA_NUM_CTX", "REPORTS_TRIAGE_THINK", "REPORTS_DRAFT_THINK"];

beforeEach(() => {
  process.env.REPORTS_ALLOW_UNKEYED = "true";
  for (const name of NAMES) delete process.env[name];
});

test("the context window defaults to 16384 and can be set", () => {
  assert.equal(loadConfig().triage.numCtx, 16384);

  process.env.REPORTS_OLLAMA_NUM_CTX = "32768";
  assert.equal(loadConfig().triage.numCtx, 32768);

  process.env.REPORTS_OLLAMA_NUM_CTX = "lots";
  assert.equal(loadConfig().triage.numCtx, 16384);

  process.env.REPORTS_OLLAMA_NUM_CTX = "512";
  assert.equal(loadConfig().triage.numCtx, 2048);
});

test("drafting follows triage's thinking unless told otherwise", () => {
  assert.equal(loadConfig().triage.draftThink, false);

  process.env.REPORTS_TRIAGE_THINK = "true";
  assert.equal(loadConfig().triage.think, true);
  assert.equal(loadConfig().triage.draftThink, true);

  process.env.REPORTS_DRAFT_THINK = "false";
  assert.equal(loadConfig().triage.think, true);
  assert.equal(loadConfig().triage.draftThink, false);

  process.env.REPORTS_TRIAGE_THINK = "false";
  process.env.REPORTS_DRAFT_THINK = "true";
  assert.equal(loadConfig().triage.think, false);
  assert.equal(loadConfig().triage.draftThink, true);
});
