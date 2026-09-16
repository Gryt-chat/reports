import consola from "consola";

import type { Config } from "./config.ts";
import { setNotified, type ReportRow } from "./db.ts";

interface Card {
  title: string;
  description: string;
  url: string | null;
  color: number;
  fields: { name: string; value: string; inline: boolean }[];
  footer: { text: string };
  timestamp: string;
}

/**
 * Post a new report to Discord and to Gryt: an inbox nobody opens is the same as no inbox.
 * Both are optional — with neither webhook the service is quiet and the admin page is the only way in.
 */
export async function notify(config: Config, report: ReportRow): Promise<void> {
  if (!config.discordWebhookUrl && !config.grytWebhookUrl) return;
  if (config.notifyOn === "never") return;
  if (report.notified_at) return;

  const card = reportCard(config, report);
  const posts: Promise<boolean>[] = [];
  if (config.discordWebhookUrl) {
    posts.push(send("Discord", config.discordWebhookUrl, { username: "Gryt reports", embeds: [card] }, report.id));
  }
  if (config.grytWebhookUrl) {
    posts.push(send("Gryt", config.grytWebhookUrl, grytMessage(card), report.id));
  }

  // One that took it is enough. Marking it again later would post it twice to the other.
  if ((await Promise.all(posts)).some(Boolean)) {
    setNotified(report.id, new Date().toISOString());
  }
}

function reportCard(config: Config, report: ReportRow): Card {
  const link = config.publicUrl ? `${config.publicUrl}/admin/reports/${report.id}` : null;
  const priority = report.triage_priority ?? "unsorted";
  const verdict = report.triage_verdict ?? "not triaged yet";

  const fields = [
    { name: "App", value: `${report.app_id} ${report.app_version ?? "?"}`, inline: true },
    {
      name: "Device",
      value: [report.platform, report.os_version, report.device_model]
        .filter(Boolean)
        .join(" ") || "unknown",
      inline: true,
    },
    { name: "Triage", value: `${verdict} · ${priority}`, inline: true },
  ];

  if (report.triage_area) {
    fields.push({ name: "Area", value: report.triage_area, inline: true });
  }
  if (report.triage_duplicate_of) {
    fields.push({
      name: "Looks like",
      value: report.triage_duplicate_of,
      inline: true,
    });
  }

  return {
    title: `${report.type === "bug" ? "Bug" : "Feedback"}: ${
      report.triage_summary ?? report.title ?? report.id
    }`.slice(0, 250),
    description: report.message.slice(0, 1500),
    url: link,
    color: report.type === "bug" ? 0xd9534f : 0x4f8ad9,
    fields,
    footer: { text: report.id },
    timestamp: report.received_at,
  };
}

/** Gryt refuses a null or blank value where Discord lets it through, so those are left out. */
function grytMessage(card: Card): Record<string, unknown> {
  const blank = (s: string | null) => !s || !s.trim();
  return {
    display_name: "Gryt reports",
    cards: [
      {
        title: card.title,
        ...(blank(card.description) ? {} : { description: card.description }),
        ...(blank(card.url) ? {} : { url: card.url }),
        color: card.color,
        fields: card.fields.filter((f) => !blank(f.name) && !blank(f.value)),
        footer: card.footer,
        timestamp: card.timestamp,
      },
    ],
  };
}

async function send(name: string, url: string, body: unknown, id: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      consola.warn(`[notify] ${name} replied ${res.status} for ${id}`);
      return false;
    }
    return true;
  } catch (err) {
    consola.warn(`[notify] Could not reach ${name} for ${id}`, err);
    return false;
  }
}
