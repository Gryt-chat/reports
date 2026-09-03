import { Alert } from "@gryt/ui";
import { useCallback, useEffect, useState } from "react";
import { Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { Rail } from "./components/Rail";
import {
  api,
  type Filter,
  type Report,
  type ReportStatus,
  type ReportSummary,
  type Stats,
} from "./lib/api";
import { People } from "./views/People";
import { ReportView } from "./views/ReportView";

function filterFrom(params: URLSearchParams): Filter {
  return {
    shelf: (params.get("shelf") as Filter["shelf"]) ?? "open",
    type: (params.get("type") as Filter["type"]) ?? undefined,
    status: (params.get("status") as Filter["status"]) ?? undefined,
    verdict: params.get("verdict") ?? undefined,
    triage: (params.get("triage") as Filter["triage"]) ?? undefined,
    unread: params.get("unread") === "1",
    q: params.get("q") ?? undefined,
    page: Number(params.get("page") ?? "1") || 1,
  };
}

export function App() {
  const [params] = useSearchParams();
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const search = params.toString();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const filter = filterFrom(new URLSearchParams(search));
      const [list, counts] = await Promise.all([api.reports(filter), api.stats()]);
      setReports(list.reports);
      setTotal(list.total);
      setStats(counts);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * A decision lands in the queue immediately.
   *
   * Re-fetching the whole list would be more correct and would also make the
   * row you just acted on jump under the cursor. This updates the one row and
   * leaves the rest where they are; the counts catch up on the next load.
   */
  const onChanged = useCallback(
    (id: string, status: ReportStatus, note: string | null) => {
      setReports((current) =>
        current.map((report) =>
          report.id === id
            ? { ...report, status, status_note: note, read_at: report.read_at ?? new Date().toISOString() }
            : report,
        ),
      );
      setStats((current) =>
        current
          ? { ...current, open: Math.max(0, current.open + (status === "new" || status === "open" ? 0 : -1)) }
          : current,
      );
    },
    [],
  );

  /* A deleted report leaves the queue at once. Re-fetching would be more
     correct and would also leave the row on screen for as long as the request
     takes, which reads as the button not having worked. The counts catch up on
     the next load, same as a decision. */
  const onDeleted = useCallback((id: string) => {
    setReports((current) => current.filter((report) => report.id !== id));
    setTotal((current) => Math.max(0, current - 1));
  }, []);

  return (
    <Routes>
      <Route
        path="/people"
        element={
          <main className="stage">
            <People />
          </main>
        }
      />
      {/* The drafts screen brings its own shell — it is a queue with a stage,
          the same shape as the inbox, because a backfill puts 35 notes in it. */}
      <Route
        path="/reports/:id"
        element={
          <Workbench
            reports={reports}
            total={total}
            stats={stats}
            loading={loading}
            error={error}
            onChanged={onChanged}
            onDeleted={onDeleted}
          />
        }
      />
      <Route
        path="*"
        element={
          <Workbench
            reports={reports}
            total={total}
            stats={stats}
            loading={loading}
            error={error}
            onChanged={onChanged}
            onDeleted={onDeleted}
          />
        }
      />
    </Routes>
  );
}

interface WorkbenchProps {
  reports: ReportSummary[];
  total: number;
  stats: Stats | null;
  loading: boolean;
  error: string | null;
  onChanged: (id: string, status: ReportStatus, note: string | null) => void;
  onDeleted: (id: string) => void;
}

function Workbench({
  reports,
  total,
  stats,
  loading,
  error,
  onChanged,
  onDeleted,
}: WorkbenchProps) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [report, setReport] = useState<Report | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setReport(null);
      return;
    }
    let live = true;
    setReportError(null);
    api
      .report(id)
      .then((next) => {
        if (live) setReport(next);
      })
      .catch((err) => {
        if (live) setReportError((err as Error).message);
      });
    return () => {
      live = false;
    };
  }, [id]);

  return (
    <div className="shell" data-view={id ? "detail" : "queue"}>
      <Rail
        reports={reports}
        total={total}
        stats={stats}
        loading={loading}
        selectedId={id ?? null}
        who={null}
      />

      <main className="stage">
        {error ? <Alert severity="error">{error}</Alert> : null}
        {reportError ? <Alert severity="error">{reportError}</Alert> : null}

        {!id ? (
          <p className="stage__empty">
            Pick a report from the queue.
          </p>
        ) : report ? (
          <ReportView
            report={report}
            onDeleted={(reportId) => {
              onDeleted(reportId);
              navigate("/");
            }}
            onChanged={(reportId, status, note) => {
              onChanged(reportId, status, note);
              setReport((current) =>
                current ? { ...current, status, status_note: note } : current,
              );
            }}
          />
        ) : (
          <p className="stage__empty">Opening…</p>
        )}
      </main>
    </div>
  );
}
