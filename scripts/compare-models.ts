// Runs the same recent reports through two Ollama models and prints what each made of them.
// By hand only. The database is opened read-only, and nothing is saved or filed.

import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import type { ReportRow } from "../src/db.ts";
import { modelFor, type TriageModel } from "../src/models.ts";
import { draftTask } from "../src/task.ts";
import { classifyReport } from "../src/triage.ts";

const USAGE = `Usage:
  node --experimental-strip-types scripts/compare-models.ts <reports.db> \\
    --url <ollama url> --models <model-a>,<model-b> [options]

Options:
  --count <n>         How many recent reports (default 5)
  --draft             Draft a task for each report as well
  --think             Let the models think while sorting
  --draft-think       Let the models think while drafting (default: same as --think)
  --no-draft-think    Don't, even with --think
  --num-ctx <n>       Context window (default 16384)
  --timeout-ms <n>    Per call (default 300000)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    url: { type: "string" },
    models: { type: "string" },
    count: { type: "string", default: "5" },
    draft: { type: "boolean", default: false },
    think: { type: "boolean", default: false },
    "draft-think": { type: "boolean" },
    "num-ctx": { type: "string", default: "16384" },
    "timeout-ms": { type: "string", default: "300000" },
    help: { type: "boolean", default: false },
  },
});

const dbPath = positionals[0];
const names = (values.models ?? "").split(",").map((s) => s.trim()).filter(Boolean);

if (values.help || !dbPath || !values.url || names.length !== 2) {
  console.error(USAGE);
  process.exit(values.help ? 0 : 1);
}

const count = Math.max(1, Number(values.count) || 5);
const think = values.think ?? false;
const draftThink = values["draft-think"] ?? think;

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db
  .prepare("SELECT * FROM reports ORDER BY received_at DESC LIMIT ?")
  .all(count) as unknown as ReportRow[];
// Duplicate spotting reads summaries production already wrote, as the live pass would.
const recent = db
  .prepare(
    "SELECT * FROM reports WHERE triage_summary IS NOT NULL ORDER BY received_at DESC LIMIT 25",
  )
  .all() as unknown as ReportRow[];
db.close();

if (rows.length === 0) {
  console.error("No reports in that database.");
  process.exit(1);
}

interface Outcome {
  verdict: string;
  priority: string;
  area: string;
  triageMs: number;
  title: string;
  draftMs: number | null;
}

async function timed<T>(fn: () => Promise<T>): Promise<[T | Error, number]> {
  const start = performance.now();
  try {
    return [await fn(), Math.round(performance.now() - start)];
  } catch (err) {
    return [err as Error, Math.round(performance.now() - start)];
  }
}

async function run(model: TriageModel, report: ReportRow): Promise<Outcome> {
  const [triage, triageMs] = await timed(() => classifyReport(model, report, recent));
  const failed = triage instanceof Error;
  const outcome: Outcome = {
    verdict: failed ? `error: ${triage.message.slice(0, 60)}` : triage.verdict,
    priority: failed ? "" : triage.priority,
    area: failed ? "" : triage.area,
    triageMs,
    title: "",
    draftMs: null,
  };

  if (values.draft) {
    // Drafting reads the verdict, so it sees this model's own triage rather than production's.
    const sorted: ReportRow = failed
      ? report
      : {
          ...report,
          triage_verdict: triage.verdict,
          triage_priority: triage.priority,
          triage_area: triage.area,
          triage_summary: triage.summary,
        };
    const [draft, draftMs] = await timed(() => draftTask(sorted, model));
    outcome.title = draft instanceof Error ? `error: ${draft.message.slice(0, 60)}` : draft.title;
    outcome.draftMs = draftMs;
  }

  return outcome;
}

const results = new Map<string, Outcome[]>();

// One model at a time so they don't fight over the card. Each one's first call includes loading.
for (const name of names) {
  const model = modelFor({
    provider: "ollama",
    model: name,
    ollamaUrl: values.url,
    keepAlive: "5m",
    timeoutMs: Number(values["timeout-ms"]) || 300_000,
    think,
    draftThink,
    numCtx: Number(values["num-ctx"]) || 16_384,
  });

  const outcomes: Outcome[] = [];
  for (const report of rows) {
    process.stderr.write(`${name} ${report.id}\n`);
    outcomes.push(await run(model, report));
  }
  results.set(name, outcomes);
}

const seconds = (ms: number | null) => (ms === null ? "" : `${(ms / 1000).toFixed(1)}s`);

console.log(`\nthink=${think} draft-think=${draftThink} num-ctx=${values["num-ctx"]}\n`);

rows.forEach((report, i) => {
  console.log(`${report.id}  ${report.message.replace(/\s+/g, " ").slice(0, 90)}`);
  const table = names.map((name) => {
    const o = results.get(name)![i];
    const row: Record<string, string> = {
      model: name,
      verdict: o.verdict,
      priority: o.priority,
      area: o.area,
      triage: seconds(o.triageMs),
    };
    if (values.draft) {
      row.draft = seconds(o.draftMs);
      row.title = o.title;
    }
    return row;
  });
  console.table(table);
});
