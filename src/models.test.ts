import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";

import { modelFor, type ModelConfig } from "./models.ts";

/**
 * An Ollama that is not Ollama.
 *
 * Enough of one to record what the service asked it for and answer with
 * whatever the test wants back. The point is the wire format: if `format` does
 * not arrive as the schema, the real one is free to answer with prose, and the
 * first anybody would know is a triage error on a live report.
 */
let ollama: http.Server;
let url: string;
let lastRequest: Record<string, unknown> | null = null;
let reply: { status: number; body: unknown } = { status: 200, body: {} };
let delayMs = 0;

const SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
  additionalProperties: false,
};

function config(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    provider: "ollama",
    model: "qwen3:8b",
    ollamaUrl: url,
    keepAlive: "5m",
    timeoutMs: 2000,
    think: false,
    ...overrides,
  };
}

before(async () => {
  ollama = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      lastRequest = JSON.parse(body || "{}") as Record<string, unknown>;
      setTimeout(() => {
        if (reply.status !== 200) {
          res.writeHead(reply.status, { "content-type": "application/json" });
          res.end(JSON.stringify(reply.body));
          return;
        }

        // Ollama streams one JSON object per line. Splitting the answer across
        // frames is the point — a reader that assumes one frame works against
        // a fast model and fails against a slow one.
        const content = (reply.body as { message?: { content?: string } }).message?.content ?? "";
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        for (const piece of content.match(/[\s\S]{1,7}/g) ?? []) {
          res.write(JSON.stringify({ message: { content: piece }, done: false }) + "\n");
        }
        res.end(JSON.stringify({ message: { content: "" }, done: true }) + "\n");
      }, delayMs);
    });
  });

  await new Promise<void>((resolve) => ollama.listen(0, "127.0.0.1", resolve));
  const address = ollama.address();
  url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(() => ollama.close());

test("asks Ollama the way Ollama expects to be asked", async () => {
  reply = { status: 200, body: { message: { content: '{"verdict":"actionable"}' } } };

  const answer = await modelFor(config()).classify("be terse", "a report", SCHEMA);
  assert.equal(answer, '{"verdict":"actionable"}');

  assert.equal(lastRequest?.model, "qwen3:8b");
  // Streamed, so Node's five-minute header deadline cannot kill a slow model.
  assert.equal(lastRequest?.stream, true);
  assert.equal(lastRequest?.think, false);
  assert.equal(lastRequest?.keep_alive, "5m");
  // The schema goes across as the format. Without this the model is free to
  // answer in prose and every report fails to parse.
  assert.deepEqual(lastRequest?.format, SCHEMA);
  // Classification, not writing: the same report has to sort the same way twice.
  assert.deepEqual(lastRequest?.options, { temperature: 0 });
  assert.deepEqual(lastRequest?.messages, [
    { role: "system", content: "be terse" },
    { role: "user", content: "a report" },
  ]);
});

test("drops the thinking a reasoning model leaves in front of its answer", async () => {
  reply = {
    status: 200,
    body: {
      message: {
        content:
          "<think>The user is switching networks, so this is ICE.</think>\n" +
          '{"verdict":"actionable"}',
      },
    },
  };

  const answer = await modelFor(config()).classify("s", "p", SCHEMA);
  assert.equal(answer, '{"verdict":"actionable"}');
  assert.equal(JSON.parse(answer).verdict, "actionable");
});

test("a refusal from the runtime is an error, not an empty verdict", async () => {
  reply = { status: 500, body: { error: "model requires more system memory" } };

  await assert.rejects(
    () => modelFor(config()).classify("s", "p", SCHEMA),
    /Ollama replied 500.*system memory/s,
  );
});

test("a model that never answers gives up rather than holding the pass open", async () => {
  reply = { status: 200, body: { message: { content: "{}" } } };
  delayMs = 500;

  try {
    await assert.rejects(
      () => modelFor(config({ timeoutMs: 60 })).classify("s", "p", SCHEMA),
      (err: Error) => err.name === "TimeoutError" || /abort/i.test(err.message),
    );
  } finally {
    delayMs = 0;
  }
});

test("the provider is part of what gets recorded", () => {
  assert.equal(modelFor(config()).name, "ollama:qwen3:8b");
  assert.equal(
    modelFor(config({ provider: "anthropic", model: "claude-opus-5" })).name,
    "anthropic:claude-opus-5",
  );
});

test("an error mid-stream is an error, not a truncated verdict", async () => {
  reply = { status: 200, body: { message: { content: "" } } };
  const original = ollama.listeners("request")[0];
  ollama.removeAllListeners("request");
  ollama.on("request", (_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write(JSON.stringify({ message: { content: '{"verd' } }) + "\n");
    res.end(JSON.stringify({ error: "model runner has stopped" }) + "\n");
  });

  try {
    await assert.rejects(
      () => modelFor(config()).classify("s", "p", SCHEMA),
      /model runner has stopped/,
    );
  } finally {
    ollama.removeAllListeners("request");
    ollama.on("request", original as never);
  }
});
