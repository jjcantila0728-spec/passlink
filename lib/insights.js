// Resolved-link cache, bypass analytics, and moderation audit log.
// All functions are best-effort: any failure (or Supabase being unconfigured)
// is swallowed so a logging/cache problem never breaks an actual bypass.

import { supabaseEnabled, sbSelect, sbUpsert, sbInsert, sbRequest, eq } from "./supabase.js";

const CACHE_TTL_DAYS = Math.max(
  0,
  Number.parseFloat(process.env.PASSLINK_CACHE_TTL_DAYS ?? "7") || 0,
);
const CACHE_ENABLED = supabaseEnabled() && CACHE_TTL_DAYS > 0;

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return null; }
}

// --- Resolved-link cache -----------------------------------------------------

// Return a fresh cached resolution for `sourceUrl`, or null. Bumps the hit
// counter (best-effort, non-atomic — fine for a popularity stat).
export async function cacheGet(sourceUrl) {
  if (!CACHE_ENABLED) return null;
  const rows = await sbSelect(
    "passlink_cache",
    `?source_url=${eq(sourceUrl)}&select=final_url,hops,elapsed_ms,handlers,hits,expires_at&limit=1`,
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  sbRequest("passlink_cache", {
    method: "PATCH",
    query: `?source_url=${eq(sourceUrl)}`,
    body: { hits: (row.hits || 0) + 1 },
  }).catch(() => {});
  return row;
}

// Store (or refresh) a resolution. Only meaningful when the link actually
// changed (final !== source); callers decide that.
export async function cachePut({ sourceUrl, finalUrl, hops, elapsedMs, handlers }) {
  if (!CACHE_ENABLED) return;
  const expiresAt = new Date(Date.now() + CACHE_TTL_DAYS * 86400_000).toISOString();
  try {
    await sbUpsert("passlink_cache", {
      source_url: sourceUrl,
      final_url: finalUrl,
      hops: hops ?? 0,
      elapsed_ms: elapsedMs ?? 0,
      handlers: handlers || null,
      hits: 1,
      expires_at: expiresAt,
    });
  } catch (e) {
    console.warn("[passlink-insights] cachePut failed:", e.message);
  }
}

// --- Bypass analytics --------------------------------------------------------

// Record one resolve attempt. `context` = { actorType, actorId, chatId }.
export async function logBypass({
  sourceUrl, finalUrl, hops, elapsedMs, ok, handler, error, cached, context = {},
}) {
  if (!supabaseEnabled()) return;
  try {
    await sbInsert("passlink_events", {
      source_url: sourceUrl,
      source_host: hostOf(sourceUrl),
      final_url: finalUrl || null,
      final_host: finalUrl ? hostOf(finalUrl) : null,
      hops: hops ?? null,
      elapsed_ms: elapsedMs ?? null,
      ok: Boolean(ok),
      handler: handler || null,
      error: error ? String(error).slice(0, 500) : null,
      actor_type: context.actorType || null,
      actor_id: context.actorId != null ? String(context.actorId) : null,
      chat_id: context.chatId != null ? String(context.chatId) : null,
      cached: Boolean(cached),
    });
  } catch (e) {
    console.warn("[passlink-insights] logBypass failed:", e.message);
  }
}

// --- Moderation audit log ----------------------------------------------------

export async function logMod({ groupId, actorId, targetId, action, reason, durationS, ok }) {
  if (!supabaseEnabled()) return;
  try {
    await sbInsert("passlink_mod_log", {
      group_id: groupId != null ? String(groupId) : null,
      actor_id: actorId != null ? String(actorId) : null,
      target_id: targetId != null ? String(targetId) : null,
      action,
      reason: reason || null,
      duration_s: durationS ?? null,
      ok: ok == null ? null : Boolean(ok),
    });
  } catch (e) {
    console.warn("[passlink-insights] logMod failed:", e.message);
  }
}
