/**
 * The service's own JSON routes, typed.
 *
 * Nothing here carries a token. The dashboard is served from the same origin as
 * the API, so the session cookie set at sign-in is simply sent; there is no
 * credential in JavaScript and nowhere for one to leak from.
 */

export type ReportType = "bug" | "feedback";
export type ReportStatus = "new" | "open" | "resolved" | "wont_do" | "duplicate";
export type TriageStatus = "pending" | "done" | "error";

export const REPORT_STATUSES: ReportStatus[] = [
  "new",
  "open",
  "resolved",
  "wont_do",
  "duplicate",
];

export interface ReportSummary {
  id: string;
  received_at: string;
  type: ReportType;
  title: string | null;
  message: string;
  contact: string | null;
  app_id: string;
  app_version: string | null;
  app_build: string | null;
  app_channel: string | null;
  app_commit: string | null;
  install_id: string | null;
  platform: string | null;
  os_version: string | null;
  device_model: string | null;
  identity_subject: string | null;
  ip: string | null;
  user_agent: string | null;
  triage_status: TriageStatus;
  triage_verdict: string | null;
  triage_priority: string | null;
  triage_summary: string | null;
  triage_area: string | null;
  triage_duplicate_of: string | null;
  triage_reasoning: string | null;
  triage_model: string | null;
  triage_at: string | null;
  triage_error: string | null;
  status: ReportStatus;
  status_note: string | null;
  status_at: string | null;
  /** The task this report was filed as, if it was. */
  task_id: number | null;
  task_url: string | null;
  read_at: string | null;
  notified_at: string | null;
}

/** The single-report route adds the diagnostics blob the listing leaves out. */
export interface Report extends ReportSummary {
  payload: Payload;
}

export interface Payload {
  type?: string;
  message?: string;
  title?: string | null;
  contact?: string | null;
  app?: Record<string, unknown>;
  device?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  context?: Record<string, unknown>;
  error?: { name?: string | null; message?: string | null; stack?: string | null } | null;
  logs?: string[];
  extra?: Record<string, unknown> | null;
}

export interface Stats {
  total: number;
  open: number;
  unread: number;
  pending: number;
  bugs: number;
  feedback: number;
}

export interface Person {
  id: string;
  identifier: string;
  subject: string | null;
  name: string | null;
  note: string | null;
  added_at: string;
  added_by: string | null;
  last_seen_at: string | null;
}

export interface Filter {
  shelf?: "open" | "closed" | "all";
  type?: ReportType;
  status?: ReportStatus;
  verdict?: string;
  triage?: TriageStatus;
  unread?: boolean;
  q?: string;
  page?: number;
}

export interface TaskDraft {
  title: string;
  description: string;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  });

  // A session that has run out, or access taken away while the tab was open.
  // Either way the answer is the same: go and sign in again.
  if (res.status === 401) {
    window.location.href = "/admin/login";
    throw new ApiError(401, "Not signed in");
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(res.status, body?.message ?? `Request failed (${res.status})`);
  }

  return (await res.json()) as T;
}

export function query(filter: Filter): string {
  const params = new URLSearchParams();
  if (filter.shelf && filter.shelf !== "open") params.set("shelf", filter.shelf);
  if (filter.type) params.set("type", filter.type);
  if (filter.status) params.set("status", filter.status);
  if (filter.verdict) params.set("verdict", filter.verdict);
  if (filter.triage) params.set("triage", filter.triage);
  if (filter.unread) params.set("unread", "1");
  if (filter.q) params.set("q", filter.q);
  if (filter.page && filter.page > 1) params.set("page", String(filter.page));
  const s = params.toString();
  return s ? `?${s}` : "";
}

export const api = {
  reports: (filter: Filter) =>
    request<{ total: number; reports: ReportSummary[] }>(`/reports${query(filter)}`),

  report: (id: string) => request<Report>(`/reports/${id}`),

  stats: () => request<Stats>("/stats"),

  setStatus: (id: string, status: ReportStatus, note: string | null) =>
    request<{ id: string; status: ReportStatus }>(`/reports/${id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, note }),
    }),

  /** Ask the model for a task. Creates nothing. */
  draftTask: (id: string) =>
    request<TaskDraft>(`/reports/${id}/task/draft`, { method: "POST" }),

  /** File it, with whatever the draft was edited into. */
  createTask: (id: string, draft: TaskDraft) =>
    request<{ id: number; url: string }>(`/reports/${id}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    }),

  retriage: (id: string) =>
    request<{ id: string }>(`/reports/${id}/retriage`, { method: "POST" }),

  people: () => request<{ people: Person[] }>("/people"),

  addPerson: (identifier: string, note: string | null) =>
    request<{ identifier: string }>("/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier, note }),
    }),

  removePerson: (id: string) =>
    request<{ ok: boolean }>(`/people/${id}/delete`, { method: "POST" }),
};
