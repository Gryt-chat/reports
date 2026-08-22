import { Alert, Button, Chip, Divider, TextField } from "@gryt/ui";
import { ArrowClockwise } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { Diagnostics } from "../components/Diagnostics";
import { api, type TaskDraft, REPORT_STATUSES, type Report, type ReportStatus } from "../lib/api";
import {
  fallbackHeading,
  fullDate,
  priorityTone,
  statusLabel,
  statusTone,
  verdictTone,
} from "../lib/format";

interface ReportViewProps {
  report: Report;
  onChanged: (id: string, status: ReportStatus, note: string | null) => void;
}

export function ReportView({ report, onChanged }: ReportViewProps) {
  const location = useLocation();
  const [note, setNote] = useState(report.status_note ?? "");
  const [busy, setBusy] = useState<ReportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* The model's answer, held here until somebody files or discards it. Nothing
     reaches the board while this is on screen. */
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [filing, setFiling] = useState(false);

  async function startDraft() {
    setDrafting(true);
    setError(null);
    try {
      setDraft(await api.draftTask(report.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not draft a task.");
    } finally {
      setDrafting(false);
    }
  }

  async function file() {
    if (!draft) return;
    setFiling(true);
    setError(null);
    try {
      const task = await api.createTask(report.id, draft);
      setDraft(null);
      /* Reload rather than patching state: filing also resolves the report,
         and the panel showing a stale status is how you file it twice. */
      window.location.assign(task.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The board would not take that.");
    } finally {
      setFiling(false);
    }
  }

  useEffect(() => {
    setNote(report.status_note ?? "");
    setError(null);
  }, [report.id, report.status_note]);

  /**
   * Deciding is optimistic and silent.
   *
   * The queue updates the moment the button is pressed and nothing announces
   * it — a toast for something you just did yourself is noise. A failure is the
   * only thing worth interrupting for, and that is what the Alert is.
   */
  async function decide(status: ReportStatus) {
    setBusy(status);
    setError(null);
    const trimmed = note.trim() || null;
    try {
      await api.setStatus(report.id, status, trimmed);
      onChanged(report.id, status, trimmed);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const triaged = report.triage_status === "done";

  return (
    <div className="stage__wrap">
      {/* On a phone the rail is hidden while a report is open, so this is the
          only way back to the queue. It carries the filter with it. */}
      <Link className="stage__back" to={{ pathname: "/", search: location.search }}>
        ← Queue
      </Link>

      <header className="stage__head">
        <p className="stage__label">
          {report.type === "bug" ? "Bug report" : "Feedback"} ·{" "}
          {fullDate(report.received_at)}
        </p>
        <h1>{report.triage_summary ?? report.title ?? fallbackHeading(report)}</h1>

        <div className="stage__tags">
          <Chip label={statusLabel(report.status)} tone={statusTone(report.status)} />
          {triaged && report.triage_verdict ? (
            <Chip
              label={report.triage_verdict.replace(/_/g, " ")}
              tone={verdictTone(report.triage_verdict)}
            />
          ) : (
            <Chip label="not triaged" tone="neutral" />
          )}
          {report.triage_priority ? (
            <Chip
              label={`${report.triage_priority} priority`}
              tone={priorityTone(report.triage_priority)}
            />
          ) : null}
          {report.triage_area ? <Chip label={report.triage_area} tone="neutral" /> : null}
        </div>
      </header>

      <p className="stage__message">{report.message}</p>

      {report.contact ? (
        <p className="rail__who">They left a way to reply: {report.contact}</p>
      ) : null}

      {report.triage_reasoning ? (
        <section className="stage__section">
          <p className="stage__label">What triage made of it</p>
          <p>{report.triage_reasoning}</p>
          {report.triage_duplicate_of ? (
            <p className="rail__who">
              Looks like a repeat of {report.triage_duplicate_of}
            </p>
          ) : null}
        </section>
      ) : null}

      {report.triage_error ? (
        <Alert severity="warning" style={{ marginTop: "1rem" }}>
          Triage could not read this one: {report.triage_error}
        </Alert>
      ) : null}

      <section className="stage__section">
        <p className="stage__label">Decide</p>
        <div className="decide">
          <div className="decide__note">
            <TextField
              label="Note"
              placeholder="Why, or the task it became"
              size="small"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>
        <div className="decide">
          {REPORT_STATUSES.filter((status) => status !== report.status).map((status) => (
            <Button
              key={status}
              size="small"
              tone={status === "resolved" ? "primary" : "neutral"}
              disabled={busy !== null}
              onClick={() => void decide(status)}
            >
              {busy === status ? "Saving…" : statusLabel(status)}
            </Button>
          ))}
          <Button
            size="small"
            tone="ghost"
            startIcon={<ArrowClockwise size={16} />}
            disabled={busy !== null}
            onClick={() => void api.retriage(report.id)}
          >
            Triage again
          </Button>
          {report.task_url ? (
            <a className="decide__filed" href={report.task_url} target="_blank" rel="noreferrer">
              Filed as #{report.task_id}
            </a>
          ) : (
            <Button
              size="small"
              tone="ghost"
              disabled={busy !== null || drafting}
              onClick={() => void startDraft()}
            >
              {drafting ? "Drafting…" : "Create task"}
            </Button>
          )}
        </div>

        {draft ? (
          <TaskDraftPanel
            draft={draft}
            filing={filing}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onFile={() => void file()}
          />
        ) : null}
        {error ? (
          <Alert severity="error" style={{ marginTop: "0.75rem" }}>
            {error}
          </Alert>
        ) : null}
      </section>

      <section className="stage__section">
        <p className="stage__label">What the app sent</p>
        <Diagnostics payload={report.payload} />
      </section>

      {report.payload.error ? (
        <section className="stage__section">
          <p className="stage__label">Error</p>
          <p className="fact__value">
            {report.payload.error.name}: {report.payload.error.message}
          </p>
          {report.payload.error.stack ? (
            <pre className="logs">{report.payload.error.stack}</pre>
          ) : null}
        </section>
      ) : null}

      {report.payload.logs && report.payload.logs.length > 0 ? (
        <section className="stage__section">
          <p className="stage__label">The tail of their log</p>
          <pre className="logs">{report.payload.logs.join("\n")}</pre>
        </section>
      ) : null}

      <Divider style={{ margin: "2rem 0 1rem" }} />

      <details>
        <summary className="rail__who" style={{ cursor: "pointer" }}>
          Everything, as it arrived
        </summary>
        <pre className="logs">{JSON.stringify(report.payload, null, 2)}</pre>
      </details>

      <p className="rail__who" style={{ marginTop: "1rem" }}>
        {report.id}
        {report.install_id ? ` · install ${report.install_id}` : ""}
        {report.identity_subject ? ` · key ${report.identity_subject}` : ""}
        {report.ip ? ` · ${report.ip}` : ""}
      </p>
    </div>
  );
}

/**
 * The drafted task, before it is anything.
 *
 * Editable, because the model is drafting from one person's description of
 * something going wrong and will sometimes read it the wrong way round. A
 * draft nobody can correct is one that gets filed wrong or thrown away, and
 * both cost more than the draft saved.
 */
function TaskDraftPanel({
  draft,
  filing,
  onChange,
  onCancel,
  onFile,
}: {
  draft: TaskDraft;
  filing: boolean;
  onChange: (draft: TaskDraft) => void;
  onCancel: () => void;
  onFile: () => void;
}) {
  return (
    <div className="draft">
      <TextField
        label="Title"
        size="small"
        value={draft.title}
        onChange={(event) => onChange({ ...draft, title: event.target.value })}
      />
      <TextField
        label="Description"
        multiline
        minRows={8}
        size="small"
        value={draft.description}
        onChange={(event) => onChange({ ...draft, description: event.target.value })}
      />
      <p className="draft__note">
        The report id and a link back to it are added when this is filed, so the
        task can be traced to what prompted it. Filing also resolves the report.
      </p>
      <div className="draft__actions">
        <Button size="small" tone="neutral" disabled={filing} onClick={onCancel}>
          Discard
        </Button>
        <Button
          size="small"
          disabled={filing || !draft.title.trim() || !draft.description.trim()}
          onClick={onFile}
        >
          {filing ? "Filing…" : "File it"}
        </Button>
      </div>
    </div>
  );
}
