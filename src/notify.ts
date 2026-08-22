import consola from "consola";

import type { Config } from "./config.ts";
import { setNotified, type ReportRow } from "./db.ts";

/**
 * Post a new report to Discord.
 *
 * An inbox nobody opens is the same as no inbox, and this is the cheapest way
 * to make a report arrive somewhere Sivert already is. Optional: with no
 * webhook configured the service is quiet and the admin page is the only way
 * in.
 */
export async function notify(config: Config, report: ReportRow): Promise<void> {
  if (!config.discordWebhookUrl) return;
  if (config.notifyOn === "never") return;
  if (report.notified_at) return;

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

  const body = {
    username: "Gryt reports",
    embeds: [
      {
        title: `${report.type === "bug" ? "Bug" : "Feedback"}: ${
          report.triage_summary ?? report.title ?? report.id
        }`.slice(0, 250),
        description: report.message.slice(0, 1500),
        url: link,
        color: report.type === "bug" ? 0xd9534f : 0x4f8ad9,
        fields,
        footer: { text: report.id },
        timestamp: report.received_at,
      },
    ],
  };

  try {
    const res = await fetch(config.discordWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      consola.warn(`[notify] Discord replied ${res.status} for ${report.id}`);
      return;
    }
    setNotified(report.id, new Date().toISOString());
  } catch (err) {
    consola.warn(`[notify] Could not reach Discord for ${report.id}`, err);
  }
}
