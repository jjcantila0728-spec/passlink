import { handlers } from "./handlers.js";
import { cacheGet, cachePut, logBypass } from "./insights.js";

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
};

const MAX_HOPS = 10;
const TIMEOUT_MS = 15000;

function normalizeUrl(input) {
  let url = String(input).trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  return new URL(url).toString();
}

function isHttpUrl(u) {
  try {
    const p = new URL(u).protocol.toLowerCase();
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

// Some shorteners terminate at a search-engine "url-wrapper" page.
// Unwrap it locally to skip a useless network hop.
function unwrapKnownWrapper(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "google.com" && u.pathname === "/url") {
      const target = u.searchParams.get("url") || u.searchParams.get("q");
      if (target && isHttpUrl(target)) return target;
    }
    if (host === "youtube.com" && u.pathname === "/redirect") {
      const target = u.searchParams.get("q");
      if (target && isHttpUrl(target)) return target;
    }
    if (host === "l.facebook.com" || host === "lm.facebook.com") {
      const target = u.searchParams.get("u");
      if (target && isHttpUrl(target)) return target;
    }
    if (host === "out.reddit.com") {
      const target = u.searchParams.get("url");
      if (target && isHttpUrl(target)) return target;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...opts,
      signal: controller.signal,
      redirect: "manual",
      headers: { ...DEFAULT_HEADERS, ...(opts.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

function findHandler(url) {
  const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  for (const h of handlers) {
    if (h.match.some((m) => (m instanceof RegExp ? m.test(host) : host === m || host.endsWith("." + m)))) {
      return h;
    }
  }
  return null;
}

export async function bypass(rawUrl, { onNote, context, skipCache = false } = {}) {
  const startedAt = Date.now();
  const source = normalizeUrl(rawUrl);
  let current = source;
  const chain = [current];
  const notes = [];
  const handlersUsed = [];
  const emit = (note) => {
    notes.push(note);
    if (typeof onNote === "function") {
      try { onNote(note); } catch { /* ignore consumer errors */ }
    }
  };

  emit(`start: ${current}`);

  // Fast path: return a previously-resolved destination and skip the ad-gate /
  // countdown entirely. Best-effort — a cache miss or error just falls through.
  if (!skipCache) {
    const cached = await cacheGet(source);
    if (cached) {
      emit(`cache hit -> ${cached.final_url} (skipping ad-gate)`);
      await logBypass({
        sourceUrl: source, finalUrl: cached.final_url, hops: cached.hops,
        elapsedMs: 0, ok: true, handler: cached.handlers, cached: true, context,
      });
      return {
        finalUrl: cached.final_url,
        chain: [source, cached.final_url].filter((v, i, a) => a.indexOf(v) === i),
        hops: cached.hops ?? 0,
        elapsedMs: 0,
        notes,
        cached: true,
      };
    }
  }

  try {
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const unwrapped = unwrapKnownWrapper(current);
    if (unwrapped && unwrapped !== current) {
      emit(`hop ${hop}: unwrapped ${new URL(current).hostname} -> ${new URL(unwrapped).hostname}`);
      current = unwrapped;
      chain.push(current);
      continue;
    }

    const handler = findHandler(current);

    if (handler) {
      emit(`hop ${hop}: matched handler "${handler.name}" for ${new URL(current).hostname}`);
      let next;
      try {
        next = await handler.resolve(current, { fetchWithTimeout, onNote: emit });
      } catch (err) {
        emit(`  handler error: ${err.message}`);
      }
      if (next && next !== current) {
        emit(`  handler resolved -> ${new URL(next).hostname}`);
        handlersUsed.push(handler.name);
        current = next;
        chain.push(current);
        continue;
      }
      emit(`  handler did not produce a new URL, falling back to redirect chain`);
    }

    emit(`hop ${hop}: GET ${current}`);
    const res = await fetchWithTimeout(current, { method: "GET" });
    const location = res.headers.get("location");

    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, current).toString();
      if (!isHttpUrl(next)) {
        emit(`hop ${hop}: ${res.status} -> non-http target (${next}), stopping`);
        break;
      }
      emit(`hop ${hop}: ${res.status} redirect -> ${new URL(next).hostname}`);
      current = next;
      chain.push(current);
      continue;
    }

    if (res.status >= 200 && res.status < 300) {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        const html = await res.text();
        const fromMeta = extractMetaRefresh(html, current);
        if (fromMeta && fromMeta !== current) {
          emit(`hop ${hop}: meta-refresh -> ${new URL(fromMeta).hostname}`);
          current = fromMeta;
          chain.push(current);
          continue;
        }
        const fromJs = extractJsRedirect(html, current);
        if (fromJs && fromJs !== current) {
          emit(`hop ${hop}: js redirect -> ${new URL(fromJs).hostname}`);
          current = fromJs;
          chain.push(current);
          continue;
        }
      }
      emit(`hop ${hop}: ${res.status} terminal`);
      break;
    }

    emit(`hop ${hop}: ${res.status} no further redirect`);
    break;
  }

  emit(`done: ${current} (${chain.length - 1} hops, ${Date.now() - startedAt}ms)`);

  const hops = chain.length - 1;
  const elapsedMs = Date.now() - startedAt;
  const handlerLabel = handlersUsed.length ? [...new Set(handlersUsed)].join(", ") : null;

  // Persist before returning: on serverless the function can freeze the instant
  // the HTTP response is flushed, so fire-and-forget writes would be lost.
  if (current !== source) {
    await cachePut({ sourceUrl: source, finalUrl: current, hops, elapsedMs, handlers: handlerLabel });
  }
  await logBypass({
    sourceUrl: source, finalUrl: current, hops, elapsedMs,
    ok: true, handler: handlerLabel, cached: false, context,
  });

  return { finalUrl: current, chain, hops, elapsedMs, notes };
  } catch (err) {
    await logBypass({
      sourceUrl: source, finalUrl: current, hops: chain.length - 1,
      elapsedMs: Date.now() - startedAt, ok: false,
      handler: handlersUsed.length ? [...new Set(handlersUsed)].join(", ") : null,
      error: err?.message || String(err), cached: false, context,
    });
    throw err;
  }
}

function resolveCandidate(raw, baseUrl) {
  try {
    const abs = new URL(raw, baseUrl).toString();
    return isHttpUrl(abs) ? abs : null;
  } catch {
    return null;
  }
}

function extractMetaRefresh(html, baseUrl) {
  const m = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']?\s*\d+\s*;\s*url=([^"'>\s]+)/i);
  return m ? resolveCandidate(m[1], baseUrl) : null;
}

function extractJsRedirect(html, baseUrl) {
  // Iterate all matches across all patterns and return the first http(s) target.
  // (Pages like google.com/url wrap their script with an "about:blank" call before the real redirect.)
  const patterns = [
    /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/gi,
    /location\.replace\(\s*["']([^"']+)["']\s*\)/gi,
    /location\.href\s*=\s*["']([^"']+)["']/gi,
    /document\.location(?:\.href)?\s*=\s*["']([^"']+)["']/gi,
    /(?:var|let|const)\s+redirectUrl\s*=\s*["']([^"']+)["']/gi,
  ];
  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      const candidate = resolveCandidate(m[1], baseUrl);
      if (candidate) return candidate;
    }
  }
  return null;
}
