// Free-proxy pool for bypassing shorteners that IP-block datacenter ranges
// (e.g. linkshortx.in behind Hostinger "hcdn" returns 403 to the serverless
// host). The pool is found from public lists, validated, and stored in Supabase
// so a known-good proxy is reused across cold starts instead of re-scanned.
//
// IMPORTANT REALITY CHECK: public free proxies are mostly dead or are
// themselves datacenter IPs that the target also blocks. At the time this was
// built a scan of ~3,900 free proxies found 0 that could reach linkshortx.in.
// This module still makes the bypasser *use* any proxy that works (free if one
// ever appears, or a paid residential one dropped into PASSLINK_PROXY_URL) with
// zero further code changes — run `npm run refresh-proxies` to repopulate.

import { supabaseEnabled, sbSelect, sbUpsert, eq } from "./supabase.js";

const COLL = "config";
const ID = "proxies";

// Public sources that publish HTTP proxies as `ip:port` (one per line).
export const PROXY_SOURCES = [
  "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&protocol=http",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
  "https://proxyspace.pro/http.txt",
];

// Anything Hostinger/CDN-style hosts would answer with for a refused request.
export function isBlockStatus(status) {
  return status === 403 || status === 429 || status === 503 || status === 421;
}

// Accept `ip:port`, `http://ip:port`, or `http://user:pass@host:port`.
export function normalizeProxy(p) {
  let s = String(p || "").trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "http://" + s;
  try {
    const u = new URL(s);
    if (!u.hostname || !u.port) return null;
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

// Proxies pinned via env (comma/space separated). Highest priority — this is
// where a paid residential proxy goes.
function envProxies() {
  return String(process.env.PASSLINK_PROXY_URL || "")
    .split(/[\s,]+/)
    .map(normalizeProxy)
    .filter(Boolean);
}

// Whether to scan public lists at request time when the stored pool yields
// nothing. ON by default (longer waits are acceptable for a blocked link);
// set PASSLINK_PROXY_AUTOHARVEST=0 to disable and rely only on the stored pool
// + refresh script. Scans are throttled (see findWorkingProxies) so a fruitless
// scan isn't repeated on every request.
export function autoHarvestEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.PASSLINK_PROXY_AUTOHARVEST || ""));
}

export async function getStoredProxies() {
  if (!supabaseEnabled()) return [];
  const rows = await sbSelect(
    "passlink_kv",
    `?coll=${eq(COLL)}&id=${eq(ID)}&select=data&limit=1`,
  );
  const data = rows[0]?.data;
  return Array.isArray(data?.proxies) ? data.proxies.map(normalizeProxy).filter(Boolean) : [];
}

export async function saveStoredProxies(proxies) {
  if (!supabaseEnabled()) return;
  const clean = [...new Set(proxies.map(normalizeProxy).filter(Boolean))].slice(0, 50);
  try {
    await sbUpsert("passlink_kv", {
      coll: COLL,
      id: ID,
      data: { proxies: clean, updatedAt: new Date().toISOString() },
    });
  } catch (e) {
    console.warn("[passlink-proxies] save failed:", e.message);
  }
}

// Ordered candidate list to try on a block: env-pinned first, then the stored
// pool. Deduped. Cheap — only env + one Supabase read.
export async function getProxyCandidates() {
  const env = envProxies();
  const stored = await getStoredProxies().catch(() => []);
  const seen = new Set();
  const out = [];
  for (const p of [...env, ...stored]) {
    if (p && !seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
}

// Move a proxy that just worked to the front of the stored pool so the next
// request tries it first. Best-effort.
export async function promoteProxy(proxy) {
  const n = normalizeProxy(proxy);
  if (!n || !supabaseEnabled()) return;
  try {
    const stored = await getStoredProxies();
    await saveStoredProxies([n, ...stored.filter((p) => p !== n)]);
  } catch { /* ignore */ }
}

// Pull `ip:port` lines from all sources into a deduped, normalized list.
export async function harvestProxies({ limit = 4000, timeoutMs = 15000 } = {}) {
  const set = new Set();
  await Promise.all(
    PROXY_SOURCES.map(async (src) => {
      try {
        const r = await fetch(src, { signal: AbortSignal.timeout(timeoutMs) });
        const text = await r.text();
        for (const line of text.split(/\s+/)) {
          const n = normalizeProxy(line);
          if (n) set.add(n);
          if (set.size >= limit) break;
        }
      } catch { /* skip dead source */ }
    }),
  );
  return [...set].slice(0, limit);
}

// Quick reachability probe: can this proxy fetch `target` and get a non-blocked
// response? Used to filter the pool before the (slower) full bypass flow.
export async function probeProxy(proxy, target, { timeoutMs = 9000 } = {}) {
  let ProxyAgent;
  try {
    ({ ProxyAgent } = await import("undici"));
  } catch {
    return false;
  }
  try {
    const agent = new ProxyAgent({ uri: proxy, connectTimeout: 4000, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    const r = await fetch(target, {
      method: "GET",
      redirect: "manual",
      dispatcher: agent,
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return !isBlockStatus(r.status) && r.status < 500;
  } catch {
    return false;
  }
}

// Throttle fruitless scans within a warm instance: a full harvest+probe is
// expensive and (currently) usually finds nothing, so don't repeat it on every
// blocked request. Cache the last scan result for SCAN_TTL_MS.
const SCAN_TTL_MS = 10 * 60 * 1000;
let _scanCache = { at: 0, working: [] };

// Harvest + concurrently probe against `target`, returning proxies that reach
// it (not blocked). Bounded so it can run inside a serverless invocation.
export async function findWorkingProxies(target, { max = 150, concurrency = 40, timeoutMs = 9000 } = {}) {
  if (Date.now() - _scanCache.at < SCAN_TTL_MS) return _scanCache.working;
  const pool = (await harvestProxies()).slice(0, max);
  const working = [];
  let i = 0;
  async function worker() {
    while (i < pool.length) {
      const p = pool[i++];
      if (await probeProxy(p, target, { timeoutMs })) working.push(p);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  _scanCache = { at: Date.now(), working };
  if (working.length) await saveStoredProxies([...working, ...(await getStoredProxies().catch(() => []))]);
  return working;
}
