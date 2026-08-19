// Minimal fetch wrapper around the Facilix API.
// Base URL defaults to "/api" (same-origin — Vite proxies it in dev, nginx
// proxies it in production). Override with VITE_API_BASE_URL at build time.

const API_BASE: string = import.meta.env.VITE_API_BASE_URL || "/api";

// The JWT is persisted in localStorage (as part of the session object) and read
// on every request. This keeps it the single source of truth, so a page refresh
// — which re-mounts the app — still authorizes requests without re-login.
export const SESSION_KEY = "facilix_session";

function getToken(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.token ?? null;
  } catch {
    return null;
  }
}

export interface Session {
  token: string;
  user: {
    id: string;
    email: string;
    full_name: string;
    role: string;
    trade: string | null;
    phone: string | null;
    organization_id: string;
    organization_name: string | null;
  };
}

// Persist the session (token + user) so it survives reloads.
export function setSession(session: Session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

export class ApiError extends Error {
  readonly status: number;
  readonly issues?: { path: string; message: string }[];

  constructor(status: number, message: string, issues?: { path: string; message: string }[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.issues = issues;
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

interface RequestOptions {
  method?: Method;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, query } = opts;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const auth = getToken();
  if (auth) headers["Authorization"] = `Bearer ${auth}`;

  const qs = query
    ? `?${new URLSearchParams(
        Object.entries(query).filter(([, v]) => v !== undefined) as [string, string][]
      )}`
    : "";

  const res = await fetch(`${API_BASE}${path}${qs}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const body = data as { error?: string; issues?: { path: string; message: string }[] };
    throw new ApiError(res.status, body?.error || `Request failed (${res.status})`, body?.issues);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions["query"]) => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// Upload a file as multipart/form-data (document attachments). The JWT goes in
// the Authorization header — never in the body.
export async function upload<T>(path: string, file: File, fields: Record<string, string>): Promise<T> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("file", file);

  const auth = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
    body: form,
  });

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const body = data as { error?: string };
    throw new ApiError(res.status, body?.error || `Upload failed (${res.status})`);
  }
  return data as T;
}

// Absolute URL of an authenticated file stream (docs carry /files/<key>).
export function fileUrl(path: string): string {
  return `${API_BASE}${path}`;
}

// Fetch a file as a blob with the JWT attached — <img> and <a> tags can't send
// Authorization headers, so previews/downloads for protected attachments go
// through this.
export async function getBlob(path: string): Promise<{ blob: Blob; type: string }> {
  const auth = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
  });
  if (!res.ok) throw new Error(`File fetch failed (${res.status})`);
  return { blob: await res.blob(), type: res.headers.get("content-type") || "" };
}

// Trigger a browser download of an authenticated endpoint's response
// (used by the self-service report builder for CSV exports).
export async function download(path: string, filename: string): Promise<void> {
  const auth = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
  });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
