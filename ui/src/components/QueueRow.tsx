import { Chip } from "@gryt/ui";
import { Link, useLocation } from "react-router-dom";

import type { ReportSummary } from "../lib/api";
import { ago, headline, priorityTone, provenance, statusLabel } from "../lib/format";

interface QueueRowProps {
  report: ReportSummary;
  selected: boolean;
}

/**
 * One report in the queue.
 *
 * Three lines, in the order a person triaging actually reads them: what it is,
 * what it says, and where it came from. The type and the priority are chips
 * because they are the two things worth spotting without reading; the status
 * only appears once it stops being `new`, so an untouched queue is quiet.
 */
export function QueueRow({ report, selected }: QueueRowProps) {
  const location = useLocation();

  return (
    <Link
      className="queue__row"
      to={{ pathname: `/reports/${report.id}`, search: location.search }}
      aria-current={selected ? "true" : undefined}
    >
      <span className="queue__meta">
        <Chip
          label={report.type === "bug" ? "Bug" : "Feedback"}
          tone={report.type === "bug" ? "danger" : "secondary"}
        />
        {report.triage_priority && report.triage_priority !== "low" ? (
          <Chip
            label={report.triage_priority}
            tone={priorityTone(report.triage_priority)}
          />
        ) : null}
        {report.status !== "new" ? (
          <Chip label={statusLabel(report.status)} tone="neutral" />
        ) : null}
        <span className="rail__who" style={{ marginLeft: "auto" }}>
          {ago(report.received_at)}
        </span>
      </span>

      <span
        className={`queue__line${report.read_at ? "" : " queue__line--unread"}`}
      >
        {headline(report)}
      </span>

      <span className="queue__sub">{provenance(report)}</span>
    </Link>
  );
}
