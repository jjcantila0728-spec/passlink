// Shared Supabase (Postgres) REST client for PassLink.
//
// Uses the secret service_role key so RLS is bypassed — server-side only, never
// expose this key to the browser. All helpers are best-effort: when Supabase is
// not configured they no-op so local/dev and the web app keep working.

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const BASE = URL ? `${URL.replace(/\/$/, "")}/rest/v1` : null;

const HEADERS = {
  apikey: KEY || "",
  Authorization: `Bearer ${KEY || ""}`,
  "Content-Type": "application/json",
};

export function supabaseEnabled() {
  return Boolean(URL && KEY);
}

// PostgREST filter value, e.g. eq("groups") -> "eq.groups" (url-encoded).
export function eq(value) {
  return `eq.${encodeURIComponent(value)}`;
}

// Low-level request. `table` + `query` form the URL; `init` is passed to fetch.
// Throws on a non-2xx response so callers can decide whether to swallow it.
export async function sbRequest(table, { method = "GET", query = "", body, prefer } = {}) {
  if (!BASE) throw new Error("Supabase not configured");
  const headers = { ...HEADERS };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}/${table}${query}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Supabase ${res.status}: ${txt}`);
  }
  // DELETE/POST with return=representation give JSON; otherwise may be empty.
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Convenience: SELECT rows. Returns [] on error (best-effort reads).
export async function sbSelect(table, query) {
  try {
    const rows = await sbRequest(table, { query });
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.warn(`[passlink-sb] select ${table} failed:`, e.message);
    return [];
  }
}

// Convenience: upsert one row (merge on primary key).
export async function sbUpsert(table, row) {
  return sbRequest(table, {
    method: "POST",
    body: row,
    prefer: "resolution=merge-duplicates",
  });
}

// Convenience: insert one row (no conflict handling).
export async function sbInsert(table, row) {
  return sbRequest(table, { method: "POST", body: row });
}

// Convenience: delete rows matching `query`, returning the deleted rows.
export async function sbDelete(table, query) {
  return sbRequest(table, { method: "DELETE", query, prefer: "return=representation" });
}
