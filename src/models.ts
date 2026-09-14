import Anthropic from "@anthropic-ai/sdk";
import consola from "consola";

/**
 * The two things that can read a report and say what it is, against the same schema. Which
 * one did it is recorded on the report, because "this triage looks wrong" is about the model.
 */
export interface TriageModel {
  /** Recorded on every report this sorts. Carries the provider, not just the model. */
  readonly name: string;
  /** Returns whatever the model said, which the schema constrains to JSON. */
  classify(system: string, prompt: string, schema: object, purpose?: Purpose): Promise<string>;
}

/** Sorting a report, or writing a task from it. Each can be told to think or not. */
export type Purpose = "triage" | "draft";

export interface ModelConfig {
  provider: "anthropic" | "ollama";
  model: string;
  ollamaUrl: string;
  /** How long Ollama keeps the weights resident after a report. */
  keepAlive: string;
  timeoutMs: number;
  /** Whether a thinking model is allowed to reason before answering. */
  think: boolean;
  /** The same, for drafting a task. */
  draftThink: boolean;
  /** Ollama's context window. Its default of 4096 overflows on a long report with thinking. */
  numCtx: number;
}

/**
 * Greedy decoding in thinking mode can loop until the timeout, so thinking gets Qwen's
 * recommended sampling. Without thinking, temperature 0 keeps the same report sorting the same way.
 */
export function samplingFor(think: boolean): Record<string, number> {
  return think ? { temperature: 0.6, top_p: 0.95, top_k: 20 } : { temperature: 0 };
}

class AnthropicModel implements TriageModel {
  readonly name: string;
  private readonly client = new Anthropic();
  private readonly model: string;

  constructor(model: string) {
    this.model = model;
    this.name = `anthropic:${model}`;
  }

  async classify(system: string, prompt: string, schema: object): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: prompt }],
      // Sorting one short report is not hard thinking, and the schema does the
      // rest of the work of keeping the answer in shape.
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: schema as Record<string, unknown> },
      },
    });

    // A safety classifier can decline outright, and a report full of abuse is exactly the
    // kind that trips one. It arrives as a 200 with no content, so check before reading.
    if (response.stop_reason === "refusal") {
      throw new Error(`Refused (${response.stop_details?.category ?? "no category"})`);
    }

    return response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
}

/**
 * A model on the machine, through Ollama. `format` takes the same JSON schema the API does,
 * so Ollama constrains the output rather than the prompt asking nicely.
 */
class OllamaModel implements TriageModel {
  readonly name: string;
  private readonly url: string;
  private readonly model: string;
  private readonly keepAlive: string;
  private readonly timeoutMs: number;
  private readonly think: boolean;
  private readonly draftThink: boolean;
  private readonly numCtx: number;

  constructor(config: ModelConfig) {
    this.url = config.ollamaUrl.replace(/\/$/, "");
    this.model = config.model;
    this.keepAlive = config.keepAlive;
    this.timeoutMs = config.timeoutMs;
    this.think = config.think;
    this.draftThink = config.draftThink;
    this.numCtx = config.numCtx;
    this.name = `ollama:${config.model}`;
  }

  async classify(
    system: string,
    prompt: string,
    schema: object,
    purpose: Purpose = "triage",
  ): Promise<string> {
    const think = purpose === "draft" ? this.draftThink : this.think;

    const res = await fetch(`${this.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Generous by API standards, because the card this runs on has a day job
      // and a queued request waits for it. Nothing is waiting on triage.
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        // Streamed, and not for progress. Node gives up if headers do not arrive within five
        // minutes, and a large model loading from disk takes longer on a shared card.
        stream: true,
        format: schema,
        keep_alive: this.keepAlive,
        // Ignored by models that do not think.
        think,
        options: { ...samplingFor(think), num_ctx: this.numCtx },
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Ollama replied ${res.status} ${detail.slice(0, 200)}`);
    }

    if (!res.body) throw new Error("Ollama sent no body");

    // One JSON object per line, each carrying the next fragment of the answer.
    let content = "";
    let pending = "";

    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      pending += new TextDecoder().decode(chunk, { stream: true });

      const lines = pending.split("\n");
      pending = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as {
          message?: { content?: string };
          error?: string;
        };
        if (frame.error) throw new Error(`Ollama: ${frame.error}`);
        content += frame.message?.content ?? "";
      }
    }

    // Belt and braces for a thinking model. `format` should leave no room for
    // one to narrate, and Qwen will do it anyway if the schema is ever dropped.
    return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  }
}

export function modelFor(config: ModelConfig): TriageModel {
  if (config.provider === "ollama") {
    consola.info(`[triage] ${config.model} on ${config.ollamaUrl}`);
    return new OllamaModel(config);
  }

  consola.info(`[triage] ${config.model} through the API`);
  return new AnthropicModel(config.model);
}
