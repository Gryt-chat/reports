import { Alert, Button, Chip, Skeleton, TextField } from "@gryt/ui";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  api,
  type ChangelogEntry,
  type ChangelogStatus,
} from "../lib/api";
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
 * the paraphrase was reading a claim and going to look for it, and a review
 * that cannot do that is somebody agreeing with prose because it reads well.
 */

const SHELVES: { label: string; status?: ChangelogStatus }[] = [
  { label: "Waiting", status: "draft" },
  { label: "Published", status: "published" },
  { label: "Rejected", status: "rejected" },
  { label: "Everything" },
];

export function Changelog() {
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

  return (
    <div className="stage__wrap">
      <p className="stage__label">Release notes</p>
      <h1>Drafted, and not yet read</h1>
      <p className="rail__who" style={{ marginTop: "0.5rem" }}>
        A model drafted these from the commits in each release. Nothing here is
        on the changelog page until you publish it.
      </p>

      <nav className="rail__filters" style={{ marginTop: "1rem" }} aria-label="Drafts">
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

      {error ? (
        <Alert severity="error" style={{ marginTop: "1rem" }}>
          {error}
        </Alert>
      ) : null}

      {loading && entries.length === 0 ? (
        <div style={{ marginTop: "1.5rem" }}>
          {[0, 1].map((n) => (
            <Skeleton key={n} height={180} style={{ marginBottom: "0.75rem" }} />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p className="rail__who" style={{ marginTop: "1.5rem" }}>
          Nothing here.
        </p>
      ) : (
        entries.map((entry) => (
          <Draft key={entry.id} entry={entry} onDecided={() => void load()} />
        ))
      )}

      <p style={{ marginTop: "1.5rem" }}>
        <Link className="rail__who" to="/">
          ← Back to the inbox
        </Link>
      </p>
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
  /* The commits are open on anything still waiting, because reading the note
     against them is the job rather than an extra somebody opts into. */
  const [showCommits, setShowCommits] = useState(waiting);

  async function decide(what: "publish" | "reject") {
    setBusy(what);
    setError(null);
    try {
      if (what === "publish") await api.publishChangelog(entry.id);
      else await api.rejectChangelog(entry.id, note.trim() || null);
      onDecided();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const total = entry.commits.reduce((n, group) => n + group.commits.length, 0);

  return (
    <article className="note">
      <header className="note__head">
        <div>
          <p className="stage__label" style={{ margin: 0 }}>
            Gryt {entry.version} · {entry.date}
          </p>
          <h2 style={{ marginTop: "0.25rem" }}>{entry.headline}</h2>
        </div>
        <div className="stage__tags" style={{ marginTop: 0 }}>
          <Chip label={statusLabel(entry.status)} tone={statusTone(entry.status)} />
          {entry.channel === "beta" ? <Chip label="beta" tone="neutral" /> : null}
        </div>
      </header>

      <p className="note__source">
        {entry.source?.since ? `since ${entry.source.since}` : "range unknown"}
        {entry.source?.commits ? ` · ${entry.source.commits} commits` : ""}
        {entry.source?.model ? ` · ${entry.source.model}` : ""}
        {` · drafted ${fullDate(entry.draftedAt)}`}
        {entry.decidedAt
          ? ` · ${entry.status} by ${entry.decidedBy ?? "somebody"} ${fullDate(entry.decidedAt)}`
          : ""}
      </p>

      {entry.note ? (
        <p className="note__why">{entry.note}</p>
      ) : null}

      {/* The note as the page would render it. Plain strings, laid out the same
          way — a heading, paragraphs, and the recap list after the article. */}
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

      {entry.commits.length ? (
        <div className="note__commits">
          <button
            type="button"
            className="note__toggle"
            onClick={() => setShowCommits((open) => !open)}
          >
            {showCommits ? "Hide" : "Show"} the {total}{" "}
            {total === 1 ? "commit" : "commits"} this came from
          </button>

          {showCommits ? (
            <div className="commits">
              {entry.commits.map((group) => (
                <section key={group.component}>
                  <p className="note__group">{group.component}</p>
                  {group.commits.map((commit, i) => (
                    <div className="commit" key={`${group.component}-${i}`}>
                      <p className="commit__subject">{commit.subject}</p>
                      {commit.body ? <pre className="commit__body">{commit.body}</pre> : null}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="note__source">
          The commit range was not sent with this draft, so there is nothing here
          to check it against.
        </p>
      )}

      {error ? (
        <Alert severity="error" style={{ marginTop: "0.75rem" }}>
          {error}
        </Alert>
      ) : null}

      {waiting ? (
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
            onClick={() => void decide("publish")}
          >
            {busy === "publish" ? "Publishing…" : "Publish"}
          </Button>
          <Button
            size="small"
            tone="danger"
            disabled={busy !== null}
            onClick={() => void decide("reject")}
          >
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </Button>
        </div>
      ) : null}
    </article>
  );
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
