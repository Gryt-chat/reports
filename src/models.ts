import Anthropic from "@anthropic-ai/sdk";
import consola from "consola";

/**
 * The two things that can read a report and say what it is.
 *
 * Both answer the same question against the same schema, so a report sorted by
 * one can be compared against the other by pointing the second at it. Which one
 * did it is recorded on the report — `ollama:qwen3:8b` rather than just the
 * model name — because "the triage on this looks wrong" is a question about the
 * model as much as the report.
 */
export interface TriageModel {
  /** Recorded on every report this sorts. Carries the provider, not just the model. */
  readonly name: string;
  /** Returns whatever the model said, which the schema constrains to JSON. */
  classify(system: string, prompt: string, schema: object): Promise<string>;
}

export interface ModelConfig {
  provider: "anthropic" | "ollama";
  model: string;
  ollamaUrl: string;
  /** How long Ollama keeps the weights resident after a report. */
  keepAlive: string;
  timeoutMs: number;
  /** Whether a thinking model is allowed to reason before answering. */
  think: boolean;
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

    // A safety classifier can decline a request outright, and a report full of
    // abuse is exactly the kind that might trip one. It arrives as a 200 with
    // no content, so it has to be checked before the content is read.
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
 * A model on the machine, through Ollama.
 *
 * `format` takes the same JSON schema the API does, so Ollama constrains what
 * the model can emit rather than the prompt asking it nicely. That is most of
 * why a small local model is enough for this job: it does not have to be good
 * at producing JSON, only at deciding what the report is.
 */
class OllamaModel implements TriageModel {
  readonly name: string;
  private readonly url: string;
  private readonly model: string;
  private readonly keepAlive: string;
  private readonly timeoutMs: number;
  private readonly think: boolean;

  constructor(config: ModelConfig) {
    this.url = config.ollamaUrl.replace(/\/$/, "");
    this.model = config.model;
    this.keepAlive = config.keepAlive;
    this.timeoutMs = config.timeoutMs;
    this.think = config.think;
    this.name = `ollama:${config.model}`;
  }

  async classify(system: string, prompt: string, schema: object): Promise<string> {
    const res = await fetch(`${this.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Generous by API standards, because the card this runs on has a day job
      // and a queued request waits for it. Nothing is waiting on triage.
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        // Streamed, and not for progress — nobody is watching. Node's HTTP
        // client gives up if headers do not arrive within five minutes, and a
        // large model that has to load from disk and then think its way to an
        // answer takes longer than that on a card it shares. Streaming returns
        // the headers immediately, so the only deadline left is the one above.
        stream: true,
        format: schema,
        keep_alive: this.keepAlive,
        // Thinking models narrate before they answer, and `format` does not
        // constrain the narration — only the answer. On a model running half
        // in RAM that reasoning is most of the wall clock, and this is a
        // four-field classification rather than a problem to work through.
        // Ignored by models that do not think.
        think: this.think,
        options: {
          // Classification, not writing. The same report should sort the same
          // way twice.
          temperature: 0,
        },
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
