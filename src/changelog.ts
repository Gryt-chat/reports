import consola from "consola";
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Config } from "./config.ts";
import {
  changelogVersions,
  decideChangelog,
  getChangelogDraft,
  insertChangelogDraft,
  liveChangelogFor,
  publishableChangelog,
  type ChangelogRow,
  type ChangelogStatus,
} from "./db.ts";
import { HttpError } from "./http.ts";

/**
 * The review gate for drafted release notes.
 *
 * `ops/internal/changelog-notes.mjs` runs on the box after a release, diffs
 * the manifests, and asks the local model for the prose. It used to write the
 * file the changelog page fetches, which meant a note nobody had read was live
 * the moment the model finished writing it. That is the arrangement this
 * replaces: the drafter posts here, the note sits as a draft, and somebody
 * reads it in the inbox and presses Publish or Reject.
 *
 * Two things this file is careful about.
 *
 * **The shape is fixed and checked here, not by the sender.** What arrives is
 * JSON from a process that is not this one, describing what a model wrote. It
 * is a headline, paragraphs, sections and a recap list, all plain strings, and
 * anything else is refused. The model never writes markup because the site
 * renders the shape with its own components — but that only holds if the shape
 * is what actually arrives, so it is checked rather than assumed.
 *
 * **The commit range is stored and never published.** Checking a claim against
 * the commits it came from is the whole review, so the range rides along with
 * the draft and is shown next to it. It is diagnostic detail about the repo and
 * has no business on a public page, so `changelog.json` gets the note alone.
 */

/** How much of a posted draft is kept. Enough for a large release. */
export const MAX_CHANGELOG_BODY = 512 * 1024;

const MAX_PARAGRAPHS = 40;
const MAX_PARAGRAPH_CHARS = 4000;
const MAX_SECTIONS = 12;
const MAX_RECAP_GROUPS = 12;
const MAX_RECAP_ITEMS = 40;

export interface ChangelogSection {
  heading: string;
  body: string[];
}

export interface ChangelogRecapGroup {
  group: string;
  items: string[];
}

export interface ChangelogSource {
  since?: string;
  commits?: number;
  model?: string;
}

/** One component's share of the range a note was drafted from. */
export interface ChangelogCommitGroup {
  component: string;
  commits: { subject: string; body: string }[];
}

export interface ChangelogDraft {
  version: string;
  date: string;
  channel: string;
  headline: string;
  intro: string[];
  sections: ChangelogSection[];
  recap: ChangelogRecapGroup[];
  source: ChangelogSource | null;
  commits: ChangelogCommitGroup[];
}

/** A draft as the inbox and the site see it, with the JSON columns parsed. */
export interface ChangelogEntry extends ChangelogDraft {
  id: string;
  status: ChangelogStatus;
  draftedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
}

function bad(message: string): never {
  throw new HttpError(400, "invalid_draft", message);
}

function text(value: unknown, what: string, max = MAX_PARAGRAPH_CHARS): string {
  if (typeof value !== "string") bad(`${what} must be a string`);
  const trimmed = (value as string).trim();
  if (!trimmed) bad(`${what} is empty`);
  return trimmed.slice(0, max);
}

function paragraphs(value: unknown, what: string, max: number): string[] {
  if (!Array.isArray(value)) bad(`${what} must be an array`);
  if (value.length > max) bad(`${what} has more than ${max} entries`);
  // A blank paragraph in the middle of a note is the model padding rather than
  // anything to render, and dropping it is kinder than refusing the draft.
  return value
    .map((p) => {
      if (typeof p !== "string") bad(`${what} must be all strings`);
      return (p as string).trim().slice(0, MAX_PARAGRAPH_CHARS);
    })
    .filter(Boolean);
}

/**
 * A posted draft, checked.
 *
 * Strict about shape and lenient about size: a field that is too long is cut
 * rather than refused, because a note the drafter spent eight minutes on should
 * not be lost to a long paragraph. A field of the wrong type is refused, since
 * there is nothing sensible to do with it.
 */
export function parseDraft(raw: unknown): ChangelogDraft {
  if (typeof raw !== "object" || raw === null) bad("Body must be a JSON object");
  const r = raw as Record<string, unknown>;

  const version = text(r.version, "version", 40);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    bad("version must look like 1.6.43");
  }

  const date = text(r.date, "date", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) bad("date must be YYYY-MM-DD");

  const channel = text(r.channel, "channel", 20);
  if (channel !== "latest" && channel !== "beta") bad("channel must be latest or beta");

  if (!Array.isArray(r.sections)) bad("sections must be an array");
  if (r.sections.length > MAX_SECTIONS) bad(`more than ${MAX_SECTIONS} sections`);
  const sections: ChangelogSection[] = r.sections.map((s, i) => {
    if (typeof s !== "object" || s === null) bad(`section ${i} is not an object`);
    const sec = s as Record<string, unknown>;
    return {
      heading: text(sec.heading, `section ${i} heading`, 300),
      body: paragraphs(sec.body, `section ${i} body`, MAX_PARAGRAPHS),
    };
  });

  const recapRaw = r.recap ?? [];
  if (!Array.isArray(recapRaw)) bad("recap must be an array");
  if (recapRaw.length > MAX_RECAP_GROUPS) bad(`more than ${MAX_RECAP_GROUPS} recap groups`);
  const recap: ChangelogRecapGroup[] = recapRaw.map((g, i) => {
    if (typeof g !== "object" || g === null) bad(`recap group ${i} is not an object`);
    const grp = g as Record<string, unknown>;
    return {
      group: text(grp.group, `recap group ${i} label`, 120),
      items: paragraphs(grp.items, `recap group ${i} items`, MAX_RECAP_ITEMS),
    };
  });

  return {
    version,
    date,
    channel,
    headline: text(r.headline, "headline", 300),
    intro: paragraphs(r.intro ?? [], "intro", MAX_PARAGRAPHS),
    sections,
    recap,
    source: parseSource(r.source),
    commits: parseCommits(r.commits),
  };
}

function parseSource(raw: unknown): ChangelogSource | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return {
    since: typeof r.since === "string" ? r.since.slice(0, 40) : undefined,
    commits: typeof r.commits === "number" && Number.isFinite(r.commits)
      ? Math.max(0, Math.floor(r.commits))
      : undefined,
    model: typeof r.model === "string" ? r.model.slice(0, 120) : undefined,
  };
}

/**
 * The range the note was drafted from.
 *
 * Optional, and a malformed one is dropped rather than refused — the note is
 * still worth reading without it, and a draft lost to a mangled commit body is
 * eight minutes of GPU nobody gets back. What it costs is that the reviewer has
 * to go and find the range themselves, which the version numbers still allow.
 */
function parseCommits(raw: unknown): ChangelogCommitGroup[] {
  if (!Array.isArray(raw)) return [];
  const groups: ChangelogCommitGroup[] = [];
  for (const g of raw.slice(0, 20)) {
    if (typeof g !== "object" || g === null) continue;
    const grp = g as Record<string, unknown>;
    if (typeof grp.component !== "string" || !Array.isArray(grp.commits)) continue;
    const commits: { subject: string; body: string }[] = [];
    for (const c of grp.commits.slice(0, 400)) {
      if (typeof c !== "object" || c === null) continue;
      const commit = c as Record<string, unknown>;
      const subject = typeof commit.subject === "string" ? commit.subject.trim() : "";
      if (!subject) continue;
      commits.push({
        subject: subject.slice(0, 300),
        body: typeof commit.body === "string" ? commit.body.trim().slice(0, 4000) : "",
      });
    }
    if (commits.length) {
      groups.push({ component: grp.component.slice(0, 60), commits });
    }
  }
  return groups;
}

export function newDraftId(): string {
  return `cl_${randomBytes(8).toString("hex")}`;
}

export function toEntry(row: ChangelogRow): ChangelogEntry {
  const parse = <T>(raw: string | null, fallback: T): T => {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: row.id,
    version: row.version,
    date: row.date,
    channel: row.channel,
    headline: row.headline,
    intro: parse<string[]>(row.intro, []),
    sections: parse<ChangelogSection[]>(row.sections, []),
    recap: parse<ChangelogRecapGroup[]>(row.recap, []),
    source: parse<ChangelogSource | null>(row.source, null),
    commits: parse<ChangelogCommitGroup[]>(row.commits, []),
    status: row.status,
    draftedAt: row.drafted_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    note: row.note,
  };
}

/**
 * Newest version first.
 *
 * By version, never by date. The February history rewrite re-pushed every old
 * tag, so v1.0.137 carries a March publish date and v1.6.21 carries 0001-01-01;
 * sorting these by `date` puts them in an order that is nobody's idea of a
 * changelog. Sorting by the string is just as wrong — it puts 1.6.9 after
 * 1.6.10 — so the numbers are compared as numbers.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): (number | string)[] =>
    v.replace(/^v/, "").split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

/**
 * Take a draft from the drafter.
 *
 * Posting the same version twice does nothing by default, so the timer can run
 * hourly and be idempotent. `force` is for asking for another go at a version
 * whose draft was refused: the old row is kept, marked superseded, and the new
 * one takes its place.
 */
export function receiveDraft(
  draft: ChangelogDraft,
  options: { force: boolean; now: string },
): { id: string; status: ChangelogStatus; created: boolean } {
  const existing = liveChangelogFor(draft.version);
  if (existing && !options.force) {
    return { id: existing.id, status: existing.status, created: false };
  }
  if (existing) {
    decideChangelog(existing.id, "superseded", existing.note, existing.decided_by, options.now);
  }

  const id = newDraftId();
  insertChangelogDraft({
    id,
    version: draft.version,
    date: draft.date,
    channel: draft.channel,
    headline: draft.headline,
    intro: JSON.stringify(draft.intro),
    sections: JSON.stringify(draft.sections),
    recap: JSON.stringify(draft.recap),
    source: draft.source ? JSON.stringify(draft.source) : null,
    commits: draft.commits.length ? JSON.stringify(draft.commits) : null,
    draftedAt: options.now,
  });
  return { id, status: "draft", created: true };
}

/** Publish or reject one, and say what it was before. */
export function decide(
  id: string,
  status: "published" | "rejected",
  note: string | null,
  by: string | null,
  now: string,
): ChangelogEntry {
  const row = getChangelogDraft(id);
  if (!row) throw new HttpError(404, "not_found", "No such draft");
  if (row.status === "superseded") {
    throw new HttpError(409, "superseded", "This draft was replaced by a later one");
  }
  if (status === "published" && row.status === "rejected") {
    // Rejecting frees the version for another attempt, so publishing a refusal
    // afterwards could put two notes on the page for one release.
    throw new HttpError(409, "rejected", "A rejected draft cannot be published");
  }
  decideChangelog(id, status, note, by, now);
  return toEntry({ ...row, status, note, decided_by: by, decided_at: now });
}

/** Versions the drafter should not spend a model on again. */
export function knownVersions(): string[] {
  return changelogVersions().sort(compareVersions);
}

/**
 * What the site is served.
 *
 * Drafts are in it, carrying `status: "draft"`, because they are unpublished
 * rather than secret — the changelog page renders published entries and shows
 * the rest only under `?drafts=1`, which is how a note gets read in place
 * before it is let out. The commit range is not in it: that is repository
 * detail, and the review is the only thing it exists for.
 */
export interface PublicChangelogEntry {
  version: string;
  date: string;
  channel: string;
  status: ChangelogStatus;
  headline: string;
  intro: string[];
  sections: ChangelogSection[];
  recap: ChangelogRecapGroup[];
  source: ChangelogSource | null;
}

export function publicDocument(now: string): {
  generatedAt: string;
  entries: PublicChangelogEntry[];
} {
  /* Field by field rather than by dropping the ones to hide. A field added to
     the row later is then absent from the page until somebody puts it here,
     which is the safe direction for a file strangers read. */
  const entries = publishableChangelog()
    .map(toEntry)
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((e) => ({
      version: e.version,
      date: e.date,
      channel: e.channel,
      status: e.status,
      headline: e.headline,
      intro: e.intro,
      sections: e.sections,
      recap: e.recap,
      source: e.source,
    }));
  return { generatedAt: now, entries };
}

/**
 * Write the file the changelog page fetches.
 *
 * To a sibling and renamed, because nginx is serving this path and a
 * half-written file is a broken changelog page rather than an old one.
 *
 * A failure is logged and swallowed. The decision is already in SQLite, the
 * next decision writes the file again, and taking the inbox down because a
 * bind mount is read-only would be the wrong trade.
 */
export function writePublicFile(config: Config, now = new Date().toISOString()): boolean {
  const path = config.changelog.file;
  if (!path) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(publicDocument(now), null, 2)}\n`);
    renameSync(tmp, path);
    return true;
  } catch (err) {
    consola.error(`[changelog] could not write ${path}: ${(err as Error).message}`);
    return false;
  }
}
