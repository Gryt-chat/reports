import { Alert, Button, Chip, Skeleton, TextField } from "@gryt/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api, type ChangelogEntry, type ChangelogStatus } from "../lib/api";
import { fullDate } from "../lib/format";

/**
 * Release notes a model wrote, before anybody outside reads them.
 *
 * The drafter on the box diffs two release manifests, takes the commit range in
 * each submodule and asks the local model for the prose. It used to write the
 * file the changelog page fetches, so a note nobody had read was public the
 * moment the model finished. Two fabricated drafts were caught by reading them
 * while that was being built — one that retold a different release wholesale,
 * and one that invented a security section about keychain encryption for a
 * release whose commits never mention a keychain.
 *
 * So the commit range is on this page next to the note. The check that caught
 * the paraphrase was reading a claim and going to look for it.
 *
 * ## Why this is a queue and not a list
 *
 * There are 42 stable releases and three notes written by hand, so a backfill
 * puts about 35 drafts here at once. The first version of this screen stacked
 * every note in full down one page, which is unreadable at that length and, more
 * to the point, invites scrolling past one rather than reading it. Same shape as
 * the report inbox instead: pick one on the left, read it on the right, decide,
 * and land on the next one still waiting.
 */

const SHELVES: { label: string; status?: ChangelogStatus }[] = [
  { label: "Waiting", status: "draft" },
  { label: "Published", status: "published" },
  { label: "Rejected", status: "rejected" },
  { label: "Everything" },
];

export function Changelog() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [shelf, setShelf] = useState<ChangelogStatus | undefined>("draft");
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries((await api.changelog(shelf)).entries);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [shelf]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => entries.find((entry) => entry.id === id) ?? null,
    [entries, id],
  );

  /**
   * Where to go after a decision.
   *
   * The next one still waiting, so a backfill of 35 is a queue that empties
   * rather than a page you keep finding your place in. Nothing left means back
   * to the empty state, which is the honest end of the job.
   */
  const decided = useCallback(
    async (entryId: string) => {
      const waiting = entries.filter((e) => e.status === "draft");
      const at = waiting.findIndex((e) => e.id === entryId);
      const next = waiting[at + 1] ?? waiting[at - 1] ?? null;
      await load();
      navigate(next && next.id !== entryId ? `/changelog/${next.id}` : "/changelog");
    },
    [entries, load, navigate],
  );

  const waiting = entries.filter((e) => e.status === "draft").length;

  return (
    <div className="shell" data-view={id ? "detail" : "queue"}>
      <aside className="rail">
        <div className="rail__head">
          <div className="rail__title">
            <h1>Release notes</h1>
          </div>
          <p className="rail__who">
            {loading
              ? " "
              : waiting > 0
                ? `${waiting} waiting to be read`
                : "Nothing waiting"}
          </p>
        </div>

        <nav className="rail__filters" aria-label="Drafts">
          {SHELVES.map((view) => (
            <button
              key={view.label}
              type="button"
              className="shelf"
              aria-current={shelf === view.status ? "page" : undefined}
              onClick={() => setShelf(view.status)}
            >
              <Chip label={view.label} tone={shelf === view.status ? "primary" : "neutral"} />
            </button>
          ))}
        </nav>

        <div className="rail__queue">
          {loading && entries.length === 0 ? (
            <div style={{ padding: "0.75rem 1rem" }}>
              {[0, 1, 2, 3, 4].map((n) => (
                <Skeleton key={n} height={56} style={{ marginBottom: "0.5rem" }} />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <p className="queue__empty">Nothing here.</p>
          ) : (
            entries.map((entry) => (
              <Link
                key={entry.id}
                className="queue__row"
                to={`/changelog/${entry.id}`}
                aria-current={entry.id === id ? "true" : undefined}
              >
                <span className="queue__meta">
                  <Chip label={`Gryt ${entry.version}`} tone="neutral" />
                  {entry.channel === "beta" ? <Chip label="beta" tone="neutral" /> : null}
                  {entry.status !== "draft" ? (
                    <Chip label={statusLabel(entry.status)} tone={statusTone(entry.status)} />
                  ) : null}
                  <span className="rail__who" style={{ marginLeft: "auto" }}>
                    {entry.date}
                  </span>
                </span>
                <span
                  className={`queue__line${entry.status === "draft" ? " queue__line--unread" : ""}`}
                >
                  {entry.headline}
                </span>
                <span className="queue__sub">{source(entry)}</span>
              </Link>
            ))
          )}
        </div>

        <div className="rail__foot">
          <span className="rail__who">
            {entries.length} {entries.length === 1 ? "note" : "notes"}
          </span>
          <Link className="rail__who" to="/">
            Back to the inbox
          </Link>
        </div>
      </aside>

      <main className="stage">
        {error ? <Alert severity="error">{error}</Alert> : null}

        {!id ? (
          <p className="stage__empty">
            {waiting > 0
              ? "Pick a note to read."
              : "Nothing to read. Which is the good outcome."}
          </p>
        ) : selected ? (
          <Draft entry={selected} onDecided={() => void decided(selected.id)} />
        ) : loading ? (
          <p className="stage__empty">Opening…</p>
        ) : (
          <p className="stage__empty">That note is not on this shelf.</p>
        )}
      </main>
    </div>
  );
}

interface DraftProps {
  entry: ChangelogEntry;
  onDecided: () => void;
}

function Draft({ entry, onDecided }: DraftProps) {
  const waiting = entry.status === "draft";
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"publish" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNote("");
    setError(null);
  }, [entry.id]);

  async function decide(what: "publish" | "reject") {
    setBusy(what);
    setError(null);
    try {
      if (what === "publish") await api.publishChangelog(entry.id);
      else await api.rejectChangelog(entry.id, note.trim() || null);
      onDecided();
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  const total = entry.commits.reduce((n, group) => n + group.commits.length, 0);

  return (
    <div className="stage__wrap">
      <Link className="stage__back" to="/changelog">
        ← Notes
      </Link>

      <header className="stage__head">
        <p className="stage__label">
          Gryt {entry.version} · {entry.date}
        </p>
        <h1>{entry.headline}</h1>

        <div className="stage__tags">
          <Chip label={statusLabel(entry.status)} tone={statusTone(entry.status)} />
          {entry.channel === "beta" ? <Chip label="beta" tone="neutral" /> : null}
        </div>

        <p className="note__source">
          {source(entry)}
          {` · drafted ${fullDate(entry.draftedAt)}`}
          {entry.decidedAt
            ? ` · ${entry.status} by ${entry.decidedBy ?? "somebody"} ${fullDate(entry.decidedAt)}`
            : ""}
        </p>

        {entry.note ? <p className="note__why">{entry.note}</p> : null}
      </header>

      {error ? (
        <Alert severity="error" style={{ marginTop: "0.75rem" }}>
          {error}
        </Alert>
      ) : null}

      {/* The decision above the note as well as below it. On a long note the
          buttons are otherwise a scroll away from the paragraph that decided
          it, and going back up to find them is where a "read it properly"
          habit turns into a "publish it, it looked fine" one. */}
      {waiting ? (
        <Decide
          note={note}
          setNote={setNote}
          busy={busy}
          onDecide={(what) => void decide(what)}
        />
      ) : null}

      <div className="note__split">
        {/* The note as the changelog page would set it: prose, one column, at a
            measure somebody can read a paragraph at. */}
        <div className="note__body">
          {entry.intro.map((paragraph, i) => (
            <p key={`intro-${i}`}>{paragraph}</p>
          ))}

          {entry.sections.map((section, i) => (
            <section key={`section-${i}`}>
              <h3>{section.heading}</h3>
              {section.body.map((paragraph, j) => (
                <p key={`p-${j}`}>{paragraph}</p>
              ))}
            </section>
          ))}

          {entry.recap.length ? (
            <div className="note__recap">
              <p className="stage__label">The short version</p>
              {entry.recap.map((group, i) => (
                <div key={`recap-${i}`}>
                  <p className="note__group">{group.group}</p>
                  <ul>
                    {group.items.map((item, j) => (
                      <li key={`item-${j}`}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {/* What the note is checked against, beside it rather than under it.
            Reading a claim and going to look for it is the check that caught
            the paraphrased security section; the guard scored that draft clean. */}
        <aside className="commits">
          <p className="stage__label">
            {total} {total === 1 ? "commit" : "commits"} it was drafted from
          </p>

          {entry.commits.length ? (
            entry.commits.map((group) => (
              <section key={group.component}>
                <p className="note__group">{group.component}</p>
                {group.commits.map((commit, i) => (
                  <div className="commit" key={`${group.component}-${i}`}>
                    <p className="commit__subject">{commit.subject}</p>
                    {commit.body ? <pre className="commit__body">{commit.body}</pre> : null}
                  </div>
                ))}
              </section>
            ))
          ) : (
            <p className="rail__who">
              The range was not sent with this draft, so there is nothing here to
              check it against.
            </p>
          )}
        </aside>
      </div>

      {waiting ? (
        <Decide
          note={note}
          setNote={setNote}
          busy={busy}
          onDecide={(what) => void decide(what)}
        />
      ) : null}
    </div>
  );
}

interface DecideProps {
  note: string;
  setNote: (value: string) => void;
  busy: "publish" | "reject" | null;
  onDecide: (what: "publish" | "reject") => void;
}

function Decide({ note, setNote, busy, onDecide }: DecideProps) {
  return (
    <div className="decide">
      <div className="decide__note">
        <TextField
          label="Why not"
          placeholder="Only if you are rejecting it"
          size="small"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      <Button
        size="small"
        tone="primary"
        disabled={busy !== null}
        onClick={() => onDecide("publish")}
      >
        {busy === "publish" ? "Publishing…" : "Publish"}
      </Button>
      <Button
        size="small"
        tone="danger"
        disabled={busy !== null}
        onClick={() => onDecide("reject")}
      >
        {busy === "reject" ? "Rejecting…" : "Reject"}
      </Button>
    </div>
  );
}

/** `since 1.6.42 · 7 commits · qwen3:32b`, skipping whatever is missing. */
function source(entry: ChangelogEntry): string {
  const commits = entry.source?.commits;
  return [
    entry.source?.since ? `since ${entry.source.since}` : "range unknown",
    commits ? `${commits} commit${commits === 1 ? "" : "s"}` : null,
    entry.source?.model,
  ]
    .filter(Boolean)
    .join(" · ");
}

function statusLabel(status: ChangelogStatus): string {
  if (status === "draft") return "Waiting";
  if (status === "published") return "Published";
  if (status === "rejected") return "Rejected";
  return "Replaced";
}

function statusTone(status: ChangelogStatus): "primary" | "success" | "danger" | "neutral" {
  if (status === "draft") return "primary";
  if (status === "published") return "success";
  if (status === "rejected") return "danger";
  return "neutral";
}
