// Site-specific handlers for shorteners that need more than a redirect chain.
// Each handler returns the *next* URL to follow (the generic engine continues from there).

// Sentinel a handler returns when the host refuses the request outright (IP
// block / 403), distinct from null ("page changed / no link found") so the
// handler can decide to retry the whole flow through a proxy.
const BLOCKED = Symbol("blocked");

function decodeHtmlAttr(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Parse the CakePHP security form (id="go-link") and return its exact <input>
// name/value pairs. The locked security field can be randomly named per page
// render, so we must echo back whatever the page actually contains — a hardcoded
// field list breaks CakePHP's SecurityComponent token and gets the POST blocked.
export function extractSecurityForm(html) {
  const forms = [...String(html || "").matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map((m) => m[0]);
  const form =
    forms.find((f) => /id="go-link"/i.test(f)) ||
    forms.find((f) => /name="_Token\[fields\]"/.test(f) && /\/links\/go/.test(f)) ||
    forms.find((f) => /name="_Token\[fields\]"/.test(f));
  if (!form) return null;
  const fields = {};
  for (const tag of form.matchAll(/<input\b[^>]*>/gi)) {
    const t = tag[0];
    const name = t.match(/\bname="([^"]*)"/i);
    if (!name) continue;
    const value = t.match(/\bvalue="([^"]*)"/i);
    fields[decodeHtmlAttr(name[1])] = value ? decodeHtmlAttr(value[1]) : "";
  }
  if (!fields._method) fields._method = "POST";
  return fields;
}

// Hostinger's application-level "disable your VPN and refresh" page. It is a
// 403, but it still sets the CakePHP session — a second GET with those cookies
// is what a browser refresh does. A hard block has the same status and no
// session, or the refresh stays on this page.
export function isVpnInterstitial(html) {
  const text = String(html || "");
  return /access denied/i.test(text) && /proxy or vpn/i.test(text);
}

// Blog steps ("Step 2 of 4") reject an immediate POST as "Link expired".
// The loading interstitial and the final seal form do not.
export function urlshortxStepDwellMs(html) {
  const raw = Number(process.env.PASSLINK_URLSHORTX_STEP_MS ?? 10000);
  const dwell = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 25000) : 10000;
  return /Step\s+\d+\s+of\s+\d+/i.test(String(html || "")) ? dwell : 0;
}

function formScore(formHtml) {
  if (/id="fwd"/i.test(formHtml)) return 100;
  if (/id="final"/i.test(formHtml)) return 90;
  if (/q7m4go\.php/i.test(formHtml)) return 80;
  if (/name="clickarlink"/i.test(formHtml)) return 70;
  if (/name="[^"]*safelink"/i.test(formHtml)) return 60;
  return 0;
}

// The ad-gate blog (hindisink and the same template) advances by posting one
// hidden field whose name changes every render (clickarlink, newwpsafelink,
// rtgsafelink, …) and finally `g` to /q7m4go.php.
export function extractForwardForm(html, baseUrl) {
  const forms = [...String(html || "").matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map((m) => m[0]);
  let best = null;
  let bestScore = 0;
  for (const form of forms) {
    const score = formScore(form);
    if (score > bestScore) {
      best = form;
      bestScore = score;
    }
  }
  if (!best) return null;
  const actionMatch = best.match(/action="([^"]*)"/i);
  let action = actionMatch ? decodeHtmlAttr(actionMatch[1]) : baseUrl;
  try {
    action = new URL(action || baseUrl, baseUrl).toString();
  } catch {
    return null;
  }
  const fields = {};
  for (const tag of best.matchAll(/<input\b[^>]*>/gi)) {
    const name = tag[0].match(/\bname="([^"]*)"/i);
    if (!name) continue;
    const value = tag[0].match(/\bvalue="([^"]*)"/i);
    fields[decodeHtmlAttr(name[1])] = value ? decodeHtmlAttr(value[1]) : "";
  }
  if (!Object.keys(fields).length) return null;
  return { action, fields };
}

function extractJsLocation(html) {
  const m = String(html || "").match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
  return m ? decodeHtmlAttr(m[1]) : null;
}

export const handlers = [
  {
    name: "adfly",
    match: ["adf.ly", "j.gs", "q.gs"],
    async resolve(url, { fetchWithTimeout }) {
      const res = await fetchWithTimeout(url, { method: "GET" });
      const html = await res.text();
      const m = html.match(/var\s+ysmm\s*=\s*['"]([^'"]+)['"]/);
      if (!m) return null;
      const ysmm = m[1];
      let left = "", right = "";
      for (let i = 0; i < ysmm.length; i++) {
        if (i % 2 === 0) left += ysmm[i];
        else right = ysmm[i] + right;
      }
      try {
        const decoded = Buffer.from(left + right, "base64").toString("utf8");
        const cleaned = decoded.replace(/^\d+/, "");
        return new URL(cleaned).toString();
      } catch {
        return null;
      }
    },
  },

  {
    name: "ouo.io",
    match: ["ouo.io", "ouo.press"],
    async resolve(url, { fetchWithTimeout }) {
      const goUrl = url.replace(/\/s\//, "/go/").replace(/^https?:\/\/([^/]+)\/([^/?#]+)$/, "https://$1/go/$2");
      const res = await fetchWithTimeout(goUrl, { method: "GET" });
      const loc = res.headers.get("location");
      if (loc) return new URL(loc, goUrl).toString();
      return null;
    },
  },

  {
    name: "linkvertise (best-effort)",
    match: [/(^|\.)linkvertise\.com$/, /(^|\.)link-to\.net$/, /(^|\.)linkvertise\.net$/],
    async resolve(url, { fetchWithTimeout }) {
      // Linkvertise is heavily JS-gated. Best-effort: try the public bypass service.
      const proxied = `https://api.bypass.vip/?url=${encodeURIComponent(url)}`;
      try {
        const res = await fetchWithTimeout(proxied, { method: "GET" });
        if (res.ok) {
          const data = await res.json();
          if (data && data.destination) return data.destination;
        }
      } catch {
        /* ignore */
      }
      return null;
    },
  },

  {
    name: "shorte.st",
    match: ["sh.st", "shorte.st", "destyy.com", "festyy.com", "corneey.com", "ceesty.com"],
    async resolve(url, { fetchWithTimeout }) {
      const res = await fetchWithTimeout(url, { method: "GET" });
      const html = await res.text();
      const m = html.match(/sessionId["'\s:]+["']([^"']+)["']/i);
      if (!m) return null;
      const host = new URL(url).hostname;
      const api = `https://${host}/shortest-url/end-adsession?adSessionId=${m[1]}&callback=jQuery`;
      const r = await fetchWithTimeout(api, { headers: { Accept: "*/*" } });
      const txt = await r.text();
      const dm = txt.match(/"destinationUrl"\s*:\s*"([^"]+)"/);
      return dm ? dm[1].replace(/\\\//g, "/") : null;
    },
  },

  {
    name: "exe.io / fc.lc / clk.sh family (Laravel)",
    match: ["exe.io", "fc.lc", "clk.sh", "social-unlock.com", "cuty.io", "try2link.com", "ay.live"],
    async resolve(url, { fetchWithTimeout }) {
      const u = new URL(url);
      const res = await fetchWithTimeout(url, { method: "GET" });
      const html = await res.text();
      const tokenMatch = html.match(/name="_token"\s+value="([^"]+)"/);
      if (!tokenMatch) return null;
      const form = new URLSearchParams();
      form.set("_token", tokenMatch[1]);
      const r = await fetchWithTimeout(`${u.origin}/links/go`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Referer: url,
        },
        body: form.toString(),
      });
      if (!r.ok) return null;
      const data = await r.json().catch(() => null);
      return data && data.url ? data.url : null;
    },
  },

  {
    // CakePHP shorteners (urlshortx.io / linkshortx / linksly and clones).
    // After a non-blocked IP:
    //   1) GET the short URL → 307 to a blog ad-gate (hindisink and the same template).
    //   2) The blog sets a one-time cookie and walks ~4 article POSTs, then
    //      /q7m4go.php redirects back to /<slug>?t=<seal>.
    //   3) The sealed page is the CakePHP countdown: POST /links/arm, wait out
    //      counter_value, POST /links/go.
    // Spoofing the ad-gate Referer no longer returns the countdown. Clones that
    // still answer that refetch with #go-link skip the blog walk.
    name: "urlshortx / linkshortx family (CakePHP)",
    match: [
      "urlshortx.io",
      "linkshortx.com",
      "linkshortx.in",
      "linksly.co",
      // Catch other clones of the same CakePHP "LinkShortener" template.
      /(^|\.)(urlshortx|linkshortx)\.[a-z.]+$/i,
    ],
    resolve: resolveUrlshortxFamily,
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hostOf(url) {
  return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
}

function makeCookieJar() {
  const byHost = new Map();
  return {
    absorb(requestUrl, res) {
      const host = hostOf(requestUrl);
      const raw = res.headers.getSetCookie
        ? res.headers.getSetCookie()
        : (res.headers.raw?.()["set-cookie"] || []);
      const jar = byHost.get(host) || new Map();
      for (const c of raw) {
        const [pair] = String(c).split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      byHost.set(host, jar);
    },
    header(requestUrl) {
      const jar = byHost.get(hostOf(requestUrl));
      if (!jar || !jar.size) return "";
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    clear(requestUrl) {
      byHost.delete(hostOf(requestUrl));
    },
  };
}

async function readText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function sameShortener(target, originHost) {
  try {
    return hostOf(target) === originHost;
  } catch {
    return false;
  }
}

// The whole gate — blog funnel included — has to stay on one IP. `proxy`
// null means direct. Returns a destination URL, null, or BLOCKED.
async function attemptUrlshortx(url, proxy, { fetchWithTimeout, onNote, isBlockStatus }) {
  const log = (m) => typeof onNote === "function" && onNote(`  [urlshortx] ${m}`);
  const blocked = (status) => (isBlockStatus ? isBlockStatus(status) : status === 403 || status === 429 || status === 503);
  const via = proxy ? { proxy } : {};
  const jar = makeCookieJar();
  const originHost = hostOf(url);
  const origin = new URL(url).origin;

  async function request(target, { method = "GET", referer, body, headers = {} } = {}) {
    const h = { ...headers };
    const cookie = jar.header(target);
    if (cookie) h.Cookie = cookie;
    if (referer) h.Referer = referer;
    // Free proxies drop the tunnel during the blog dwell. One retry covers a
    // connect failure. A POST that actually reached the origin is single-use;
    // if the retry then gets "Link expired", the funnel stops and the next
    // proxy starts clean.
    const tries = 2;
    let lastErr;
    for (let n = 0; n < tries; n++) {
      try {
        const res = await fetchWithTimeout(target, { method, headers: h, body, timeoutMs: 25000, ...via });
        jar.absorb(target, res);
        return res;
      } catch (err) {
        lastErr = err;
        if (n + 1 < tries) log(`request failed (${err.message}); retrying ${method}`);
      }
    }
    throw lastErr;
  }

  // Walk the blog until it seals a return URL on the shortener itself.
  async function completeAdGate(startUrl) {
    let nextUrl = startUrl;
    let referer = url;
    let pending = null;
    for (let step = 0; step < 8; step++) {
      const res = pending || await request(nextUrl, { referer });
      pending = null;
      const here = nextUrl;
      if (blocked(res.status)) {
        log(`ad gate refused with ${res.status} (${hostOf(here)})`);
        await readText(res);
        return BLOCKED;
      }
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        await readText(res);
        const abs = new URL(loc, here).toString();
        if (sameShortener(abs, originHost)) return abs;
        referer = here;
        nextUrl = abs;
        continue;
      }
      const html = await readText(res);
      if (/<title>\s*link expired/i.test(html)) {
        log("blog step expired before it could be posted");
        return null;
      }
      if (isVpnInterstitial(html) || /<title>\s*access denied/i.test(html) || /checking your browser/i.test(html)) {
        log(`ad gate blocked (${hostOf(here)})`);
        return BLOCKED;
      }
      const form = extractForwardForm(html, here);
      if (!form) {
        const js = extractJsLocation(html);
        if (!js) {
          log("ad gate page had no forward form");
          return null;
        }
        const abs = new URL(js, here).toString();
        if (!/^https?:/i.test(abs)) return null;
        if (sameShortener(abs, originHost)) return abs;
        referer = here;
        nextUrl = abs;
        continue;
      }
      const dwell = urlshortxStepDwellMs(html);
      if (dwell) {
        log(`blog step is timed; waiting ${Math.round(dwell / 1000)}s`);
        await sleep(dwell);
      }
      log(`blog POST ${new URL(form.action).pathname} [${Object.keys(form.fields).join(", ")}]`);
      referer = here;
      nextUrl = form.action;
      pending = await request(form.action, {
        method: "POST",
        referer: here,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: new URL(form.action).origin,
        },
        body: new URLSearchParams(form.fields).toString(),
      });
    }
    log("ad gate did not seal a return URL");
    return null;
  }

  log(`priming session${proxy ? " (via proxy)" : ""}`);
  let first = await request(url);
  if (blocked(first.status)) {
    const body = await readText(first);
    if (isVpnInterstitial(body) && jar.header(url)) {
      log("403 asks for a refresh; retrying once with the session cookies");
      first = await request(url, { referer: origin + "/" });
    }
  }
  if (blocked(first.status)) {
    log(`priming refused with ${first.status} (IP block)`);
    await readText(first);
    return BLOCKED;
  }

  let html = "";
  // Referer for /links/arm and /links/go must be the page that issued the form.
  let formPage = url;
  const primeLoc = first.headers.get("location");
  if (first.status >= 300 && first.status < 400 && primeLoc && /^https?:/i.test(primeLoc)) {
    await readText(first);
    const adUrl = new URL(primeLoc, url).toString();
    let adHost = hostOf(url);
    try { adHost = hostOf(adUrl); } catch { /* keep shortener host */ }
    log(`ad gate: ${adHost}; trying legacy referer refetch`);
    const second = await request(url, { referer: new URL(adUrl).origin + "/" });
    if (blocked(second.status)) {
      log(`refetch refused with ${second.status} (IP block)`);
      await readText(second);
      return BLOCKED;
    }
    if (second.ok) html = await readText(second);
    else await readText(second);
    if (!extractSecurityForm(html || "")) {
      const secondLoc = second.headers.get("location");
      const funnelStart = secondLoc ? new URL(secondLoc, url).toString() : adUrl;
      log("legacy refetch had no countdown form; walking the blog funnel");
      const sealed = await completeAdGate(funnelStart);
      if (sealed === BLOCKED) return BLOCKED;
      if (!sealed) return null;
      log(`sealed return ${new URL(sealed).pathname}${new URL(sealed).search ? "?t=…" : ""}`);

      // The seal is usually enough on its own. Keep the pre-gate session for
      // the first try (same IP); if the host sends us back to the ad gate,
      // drop those cookies and load the seal as a fresh visit.
      const openSealed = async () => {
        let current = sealed;
        let referer = new URL(adUrl).origin + "/";
        for (let hop = 0; hop < 3; hop++) {
          const page = await request(current, { referer });
          if (blocked(page.status)) {
            log(`sealed page refused with ${page.status}`);
            await readText(page);
            return BLOCKED;
          }
          const loc = page.headers.get("location");
          if (page.status >= 300 && page.status < 400 && loc) {
            await readText(page);
            const abs = new URL(loc, current).toString();
            log(`sealed hop ${page.status} -> ${hostOf(abs)}`);
            if (!sameShortener(abs, originHost)) return null;
            referer = current;
            current = abs;
            continue;
          }
          if (!page.ok) {
            log(`sealed page returned ${page.status}`);
            await readText(page);
            return null;
          }
          formPage = current;
          return readText(page);
        }
        return null;
      };

      html = await openSealed();
      if (html === BLOCKED) return BLOCKED;
      if (!extractSecurityForm(html || "")) {
        log("sealed page had no countdown form; retrying without the pre-gate session");
        jar.clear(url);
        html = await openSealed();
        if (html === BLOCKED) return BLOCKED;
      }
    }
  } else if (first.ok) {
    html = await readText(first);
  } else {
    log(`priming returned ${first.status}`);
    await readText(first);
    return null;
  }

  const fields = extractSecurityForm(html);
  if (!fields || !fields._csrfToken || !fields["_Token[fields]"]) {
    log("security form fields not found on page, aborting");
    return null;
  }
  const body = new URLSearchParams(fields).toString();
  const postHeaders = () => ({
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "X-CSRF-Token": fields._csrfToken,
    Origin: origin,
  });

  if (/\/links\/arm\b/.test(html)) {
    log("arming link (POST /links/arm) before countdown");
    const armRes = await request(`${origin}/links/arm`, {
      method: "POST",
      referer: formPage,
      headers: postHeaders(),
      body,
    });
    log(`arm returned ${armRes.status}`);
    await readText(armRes);
  }

  let counterValue = 5;
  const cm = html.match(/"counter_value"\s*:\s*(\d+)/);
  if (cm) {
    const n = parseInt(cm[1], 10);
    if (Number.isFinite(n)) counterValue = Math.min(Math.max(n, 0), 30);
  }
  log(`countdown is server-enforced; waiting ${counterValue + 1}s before submitting form`);
  await sleep((counterValue + 1) * 1000);

  log(`POST ${origin}/links/go with CSRF + security token`);
  const r = await request(`${origin}/links/go`, {
    method: "POST",
    referer: formPage,
    headers: postHeaders(),
    body,
  });
  if (!r.ok) {
    log(`POST returned ${r.status}, aborting`);
    await readText(r);
    return null;
  }
  const data = await r.json().catch(() => null);
  if (data && data.status === "error") {
    log(`server rejected POST: ${data.message || "unknown"}`);
    return null;
  }
  if (data && data.url) {
    log(`server returned destination: ${data.url}`);
    // Newer templates return a relative gateway ("/links/gw/<token>") that is
    // still on the blocked host, so it has to be followed on this same route.
    let dest = new URL(data.url, origin).toString();
    for (let i = 0; i < 3 && hostOf(dest) === originHost; i++) {
      log(`following gateway hop via same route: ${new URL(dest).pathname}`);
      const gw = await request(dest, { referer: formPage });
      const loc = gw.headers.get("location");
      if (!loc) {
        log(`gateway returned ${gw.status} with no redirect; stopping`);
        await readText(gw);
        break;
      }
      await readText(gw);
      dest = new URL(loc, dest).toString();
      log(`gateway -> ${hostOf(dest)}`);
    }
    return dest;
  }
  log("response did not contain a url");
  return null;
}

export async function resolveUrlshortxFamily(url, ctx = {}) {
  const { fetchWithTimeout, onNote, isBlockStatus, getProxies, findProxies, onProxyWorked } = ctx;
  const log = (m) => typeof onNote === "function" && onNote(`  [urlshortx] ${m}`);
  const mask = (p) => {
    try {
      const u = new URL(p);
      return `${u.protocol}//${u.hostname}:${u.port}`;
    } catch {
      return "proxy";
    }
  };

  // Try direct first. A 403 from this host means the cookies, the blog funnel,
  // and the countdown POST all have to be redone from one unblocked IP.
  let result = await attemptUrlshortx(url, null, { fetchWithTimeout, onNote, isBlockStatus });
  if (result !== BLOCKED) return result;

  const tried = new Set();
  const runList = async (list, label) => {
    for (const proxy of (list || []).slice(0, 8)) {
      if (!proxy || tried.has(proxy)) continue;
      tried.add(proxy);
      log(`IP-blocked; retrying full flow via ${label} ${mask(proxy)}`);
      let r;
      try {
        r = await attemptUrlshortx(url, proxy, { fetchWithTimeout, onNote, isBlockStatus });
      } catch (e) {
        log(`proxy ${mask(proxy)} errored: ${e.message}`);
        continue;
      }
      if (r && r !== BLOCKED) {
        if (typeof onProxyWorked === "function") await onProxyWorked(proxy).catch(() => {});
        return r;
      }
    }
    return null;
  };

  let viaProxy = await runList(getProxies ? await getProxies().catch(() => []) : [], "pooled proxy");
  if (!viaProxy && findProxies) {
    log("no pooled proxy worked; scanning fresh free proxies…");
    viaProxy = await runList(await findProxies().catch(() => []), "fresh proxy");
  }
  if (viaProxy) return viaProxy;

  log("blocked and no working proxy available — giving up");
  return null;
}
