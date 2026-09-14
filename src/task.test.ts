import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import type { ReportRow } from "./db.ts";
import { HttpError } from "./http.ts";
import { modelFor, type Purpose, type TriageModel } from "./models.ts";
import { draftTask } from "./task.ts";

const REPORT = {
  id: "rep_test",
  type: "bug",
  app_id: "desktop",
  app_version: "1.0.0",
  platform: "macos",
  os_version: "15",
  message: "Voice drops when I switch networks.",
  triage_verdict: null,
  triage_summary: null,
} as unknown as ReportRow;

function answering(fn: () => Promise<string>): TriageModel & { purposes: Purpose[] } {
  const purposes: Purpose[] = [];
  return {
    name: "fake",
    purposes,
    classify: (_s, _p, _schema, purpose) => {
      purposes.push(purpose ?? "triage");
      return fn();
    },
  };
}

function isHttpError(status: number, code: string) {
  return (err: unknown) => {
    assert.ok(err instanceof HttpError, `not an HttpError: ${String(err)}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  };
}

test("a draft is asked for as a draft, not as triage", async () => {
  const model = answering(async () => '{"title":"t","description":"d"}');
  assert.deepEqual(await draftTask(REPORT, model), { title: "t", description: "d" });
  assert.deepEqual(model.purposes, ["draft"]);
});

test("a model that runs out of time is a 504 the inbox can show", async () => {
  const model = answering(async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });

  await assert.rejects(() => draftTask(REPORT, model), isHttpError(504, "draft_timeout"));
});

test("a timeout in the middle of Ollama's stream is the same 504", async () => {
  // One frame and then nothing, which is what a model that thinks in a loop looks like.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write(JSON.stringify({ message: { content: "" }, done: false }) + "\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const model = modelFor({
    provider: "ollama",
    model: "qwen3:14b",
    ollamaUrl: `http://127.0.0.1:${port}`,
    keepAlive: "5m",
    timeoutMs: 100,
    think: true,
    draftThink: true,
    numCtx: 16384,
  });

  try {
    await assert.rejects(() => draftTask(REPORT, model), isHttpError(504, "draft_timeout"));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("any other failure is a 502 that says what went wrong", async () => {
  const model = answering(async () => {
    throw new Error("Ollama replied 500 model requires more system memory");
  });

  await assert.rejects(
    () => draftTask(REPORT, model),
    (err: unknown) =>
      isHttpError(502, "draft_failed")(err) && /system memory/.test((err as Error).message),
  );
});

test("an empty or broken answer keeps its own error", async () => {
  await assert.rejects(
    () => draftTask(REPORT, answering(async () => "")),
    isHttpError(502, "no_draft"),
  );
  await assert.rejects(
    () => draftTask(REPORT, answering(async () => "not json")),
    isHttpError(502, "bad_draft"),
  );
});
