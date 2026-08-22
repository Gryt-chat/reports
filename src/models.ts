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

  constructor(config: ModelConfig) {
    this.url = config.ollamaUrl.replace(/\/$/, "");
    this.model = config.model;
    this.keepAlive = config.keepAlive;
    this.timeoutMs = config.timeoutMs;
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
        stream: false,
        format: schema,
        keep_alive: this.keepAlive,
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

    const body = (await res.json()) as { message?: { content?: string } };
    const content = body.message?.content ?? "";

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
