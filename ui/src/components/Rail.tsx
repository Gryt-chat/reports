import { Chip, Skeleton, TextField } from "@gryt/ui";
import { Link, useSearchParams } from "react-router-dom";

import type { ReportSummary, Stats } from "../lib/api";
import { QueueRow } from "./QueueRow";

/**
 * The named views, in the order somebody actually works through them.
 *
 * Open first because that is the job; the closed shelves are here so a decision
 * can be found again, not so they can be browsed.
 */
const VIEWS: { label: string; params: string }[] = [
  { label: "Open", params: "" },
  { label: "Unread", params: "unread=1" },
  { label: "Bugs", params: "type=bug" },
  { label: "Feedback", params: "type=feedback" },
  { label: "Actionable", params: "verdict=actionable" },
  { label: "Untriaged", params: "triage=pending" },
  { label: "Resolved", params: "status=resolved" },
  { label: "Everything", params: "shelf=all" },
];

interface RailProps {
  reports: ReportSummary[];
  total: number;
  stats: Stats | null;
  loading: boolean;
  selectedId: string | null;
  who: string | null;
}

export function Rail({ reports, total, stats, loading, selectedId, who }: RailProps) {
  const [params, setParams] = useSearchParams();
  const active = params.toString();

  return (
    <aside className="rail">
      <div className="rail__head">
        <div className="rail__title">
          <h1>Reports</h1>
          {who ? <span className="rail__who">{who}</span> : null}
        </div>
        <p className="rail__who">
          {stats
            ? `${stats.open} open · ${stats.unread} unread · ${stats.pending} untriaged`
            : " "}
        </p>
      </div>

      <nav className="rail__filters" aria-label="Views">
        {VIEWS.map((view) => {
          const isActive = active === view.params;
          return (
            <Link
              key={view.label}
              to={view.params ? `/?${view.params}` : "/"}
              aria-current={isActive ? "page" : undefined}
              style={{ textDecoration: "none" }}
            >
              <Chip label={view.label} tone={isActive ? "primary" : "neutral"} />
            </Link>
          );
        })}
      </nav>

      <div className="rail__search">
        <TextField
          label="Search"
          placeholder="Search what people wrote"
          size="small"
          defaultValue={params.get("q") ?? ""}
          onChange={(event) => {
            const next = new URLSearchParams(params);
            const value = event.target.value.trim();
            if (value) next.set("q", value);
            else next.delete("q");
            next.delete("page");
            setParams(next, { replace: true });
          }}
        />
      </div>

      <div className="rail__queue">
        {loading && reports.length === 0 ? (
          <div style={{ padding: "0.75rem 1rem" }}>
            {[0, 1, 2, 3, 4].map((n) => (
              <Skeleton key={n} height={56} style={{ marginBottom: "0.5rem" }} />
            ))}
          </div>
        ) : reports.length === 0 ? (
          <p className="queue__empty">
            Nothing here.
            <br />
            <span className="rail__who">Which is the good outcome.</span>
          </p>
        ) : (
          reports.map((report) => (
            <QueueRow
              key={report.id}
              report={report}
              selected={report.id === selectedId}
            />
          ))
        )}
      </div>

      <div className="rail__foot">
        <span className="rail__who">
          {total} {total === 1 ? "report" : "reports"}
        </span>
        <span style={{ display: "flex", gap: "0.75rem" }}>
          <Link className="rail__who" to="/people">
            People
          </Link>
          <a className="rail__who" href="/admin/logout">
            Sign out
          </a>
        </span>
      </div>
    </aside>
  );
}
