import type { ReportStatus, ReportSummary } from "./api";

/**
 * How long ago, in the shortest form that is still unambiguous.
 *
 * Triage is a scanning job — the exact second a report arrived matters far less
 * than whether it turned up this morning or last month, and the full timestamp
 * is on the report itself for when it does.
 */
export function ago(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";

  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;

  return new Date(iso).toISOString().slice(0, 10);
}

export function fullDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toISOString().replace("T", " ").slice(0, 16);
}

const STATUS_LABELS: Record<ReportStatus, string> = {
  new: "New",
  open: "Open",
  resolved: "Resolved",
  wont_do: "Won't do",
  duplicate: "Duplicate",
};

export function statusLabel(status: ReportStatus): string {
  return STATUS_LABELS[status] ?? status;
}

/** The tone a status wears. Closed states are quiet on purpose. */
export function statusTone(status: ReportStatus): "primary" | "success" | "neutral" {
  if (status === "open") return "primary";
  if (status === "resolved") return "success";
  return "neutral";
}

export function verdictTone(
  verdict: string | null,
): "success" | "warning" | "neutral" | "danger" {
  switch (verdict) {
    case "actionable":
      return "success";
    case "needs_info":
      return "warning";
    case "noise":
      return "neutral";
    case "not_a_bug":
      return "neutral";
    default:
      return "neutral";
  }
}

export function priorityTone(priority: string | null): "danger" | "warning" | "neutral" {
  if (priority === "high") return "danger";
  if (priority === "normal") return "warning";
  return "neutral";
}

/**
 * The one line that stands for a report in the queue.
 *
 * Triage's summary when there is one, because it is written to be scanned;
 * otherwise whatever the person actually typed, which is never worse than a
 * placeholder.
 */
export function headline(report: ReportSummary): string {
  return report.triage_summary ?? report.title ?? report.message;
}

/**
 * What to call a report that triage has not summarised.
 *
 * "Untitled report" is what this said first, which is true and useless — and it
 * was every heading until an API key turned up. Where it came from is the next
 * most useful thing, and unlike the message it is not already on screen
 * directly underneath.
 */
export function fallbackHeading(report: ReportSummary): string {
  const kind = report.type === "bug" ? "Bug" : "Feedback";
  const from = [report.app_id, report.app_version].filter(Boolean).join(" ");
  return from ? `${kind} from ${from}` : `${kind} report`;
}

/** `mobile 1.4.0 · ios 18.2 · iPhone15,3`, skipping whatever is missing. */
export function provenance(report: ReportSummary): string {
  return [
    [report.app_id, report.app_version].filter(Boolean).join(" "),
    [report.platform, report.os_version].filter(Boolean).join(" "),
    report.device_model,
  ]
    .filter(Boolean)
    .join(" · ");
}
