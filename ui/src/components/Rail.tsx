import { Chip, Skeleton, TextField } from "@gryt/ui";
import { Link, useSearchParams } from "react-router-dom";

import type { ReportSummary, Stats } from "../lib/api";
import { QueueRow } from "./QueueRow";

/**
 * The named views, in the order somebody actually works through them.
 *
 * Open first because that is the job. None of these carry a shelf: whether
 * settled reports are included is the toggle below, so it survives moving
 * between views instead of being a property of one of them.
 *
 * "Everything" used to mean `shelf=all`, which made the one view broad enough
 * to browse also the only view showing work already done — and with every
 * report settled it was the only view with anything in it at all.
 */
const VIEWS: { label: string; params: string }[] = [
  { label: "Open", params: "" },
  { label: "Unread", params: "unread=1" },
  { label: "Bugs", params: "type=bug" },
  { label: "Feedback", params: "type=feedback" },
  { label: "Actionable", params: "verdict=actionable" },
  { label: "Untriaged", params: "triage=pending" },
];

/** Everything that is no longer waiting on anybody. */
const SETTLED_LABEL = "Show settled";

interface RailProps {
  reports: ReportSummary[];
  total: number;
  stats: Stats | null;
  loading: boolean;
  selectedId: string | null;
  who: string | null;
}

/** A view's link, carrying the settled toggle across so it does not reset. */
function viewHref(viewParams: string, showSettled: boolean): string {
  const next = new URLSearchParams(viewParams);
  if (showSettled) next.set("shelf", "all");
  const query = next.toString();
  return query ? `/?${query}` : "/";
}

export function Rail({ reports, total, stats, loading, selectedId, who }: RailProps) {
  const [params, setParams] = useSearchParams();

  /* The shelf is a toggle rather than a view, so it must not decide which view
     is highlighted — otherwise turning it on makes every chip look inactive. */
  const withoutShelf = new URLSearchParams(params);
  withoutShelf.delete("shelf");
  withoutShelf.delete("page");
  const active = withoutShelf.toString();
  const showSettled = params.get("shelf") === "all";

  const toggleSettled = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set("shelf", "all");
    else next.delete("shelf");
    next.delete("page");
    setParams(next, { replace: true });
  };

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
              to={viewHref(view.params, showSettled)}
              aria-current={isActive ? "page" : undefined}
              style={{ textDecoration: "none" }}
            >
              <Chip label={view.label} tone={isActive ? "primary" : "neutral"} />
            </Link>
          );
        })}
      </nav>

      {/* Off by default. Settled reports are kept so a decision can be found
          again, not so they sit in front of the ones still waiting. */}
      <label className="rail__settled">
        <input
          type="checkbox"
          checked={showSettled}
          onChange={(event) => toggleSettled(event.target.checked)}
        />
        <span className="rail__who">{SETTLED_LABEL}</span>
      </label>

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
          {/* The count only when there is one. The page is worth reaching
              either way — it is also where a published note is found again —
              but a zero in the footer of every visit is not news. */}
          <Link className="rail__who" to="/changelog">
            Notes{stats && stats.changelogDrafts > 0 ? ` (${stats.changelogDrafts})` : ""}
          </Link>
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
