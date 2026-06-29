// Site-specific handlers for shorteners that need more than a redirect chain.
// Each handler returns the *next* URL to follow (the generic engine continues from there).

// Sentinel a handler returns when the host refuses the request outright (IP
// block / 403), distinct from null ("page changed / no link found") so the
// handler can decide to retry the whole flow through a proxy.
const BLOCKED = Symbol("blocked");

// Parse the CakePHP security form (id="go-link") and return its exact <input>
// name/value pairs. The locked security field can be randomly named per page
// render, so we must echo back whatever the page actually contains — a hardcoded
// field list breaks CakePHP's SecurityComponent token and gets the POST blocked.
function extractSecurityForm(html) {
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map((m) => m[0]);
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
    fields[name[1]] = value ? value[1] : "";
  }
  if (!fields._method) fields._method = "POST";
  return fields;
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
    // CakePHP-based shorteners (LinkShortX / urlshortx.io family).
    // Two-step gate:
    //   1) First GET returns 307 to an "ad gate" domain and sets refXXX + AppSession cookies.
    //   2) Second GET with those cookies + Referer returns the real countdown page.
    //   3) POST /links/go with the CSRF + ad_form_data fields returns JSON {url}.
    name: "urlshortx / linkshortx family (CakePHP)",
    match: [
      "urlshortx.io",
      "linkshortx.com",
      "linkshortx.in",
      "linksly.co",
      // Catch other clones of the same CakePHP "LinkShortener" template.
      /(^|\.)(urlshortx|linkshortx)\.[a-z.]+$/i,
    ],
    async resolve(url, { fetchWithTimeout, onNote, isBlockStatus, getProxies, findProxies, onProxyWorked }) {
      const log = (m) => typeof onNote === "function" && onNote(`  [urlshortx] ${m}`);
      const blocked = (s) => (isBlockStatus ? isBlockStatus(s) : s === 403 || s === 429 || s === 503);
      const mask = (p) => { try { const u = new URL(p); return `${u.protocol}//${u.hostname}:${u.port}`; } catch { return "proxy"; } };

      // Try direct first. If the site IP-blocks our host (403/429/503), the
      // cookies/CSRF/arm/countdown/POST flow must all originate from one
      // un-blocked IP — a single-request relay won't do — so we re-run the
      // *entire* flow through each candidate proxy until one completes. Longer
      // total time is acceptable.
      let result = await attempt(null);
      if (result !== BLOCKED) return result;

      const tried = new Set();
      const runList = async (list, label) => {
        for (const proxy of (list || []).slice(0, 8)) {
          if (!proxy || tried.has(proxy)) continue;
          tried.add(proxy);
          log(`IP-blocked; retrying full flow via ${label} ${mask(proxy)}`);
          let r;
          try {
            r = await attempt(proxy);
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

      // 1) Known pool (env-pinned + previously-validated, from storage).
      let viaProxy = await runList(getProxies ? await getProxies().catch(() => []) : [], "pooled proxy");
      // 2) Optional: harvest + probe fresh free proxies on demand.
      if (!viaProxy && findProxies) {
        log("no pooled proxy worked; scanning fresh free proxies…");
        viaProxy = await runList(await findProxies().catch(() => []), "fresh proxy");
      }
      if (viaProxy) return viaProxy;

      log("blocked and no working proxy available — giving up");
      return null;

      // attempt(): one full pass of the gate, optionally through `proxy`.
      // Returns the destination URL, null (page changed / no link), or the
      // BLOCKED sentinel when the host refuses the request.
      async function attempt(proxy) {
        const u = new URL(url);
        const via = proxy ? { proxy } : {};
        // Cookie jar scoped to this origin only — never forward cookies set by the ad-gate domain.
        const jar = new Map();

        const merge = (res) => {
          const raw = res.headers.getSetCookie
            ? res.headers.getSetCookie()
            : (res.headers.raw?.()["set-cookie"] || []);
          for (const c of raw) {
            const [pair] = c.split(";");
            const eq = pair.indexOf("=");
            if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
          }
        };
        const cookieHeader = () =>
          Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");

        // Step 1: prime cookies. First visit returns 307 to an ad-gate domain
        // and sets AppSession + ref<slug> cookies on this origin. Stop here —
        // don't actually visit the ad-gate, its cookies aren't ours.
        log(`priming session${proxy ? " (via proxy)" : ""} (GET, expect 307 to ad gate)`);
        const first = await fetchWithTimeout(url, { method: "GET", ...via });
        if (blocked(first.status)) {
          log(`priming refused with ${first.status} (IP block)`);
          return BLOCKED;
        }
        merge(first);
        const adGate = first.headers.get("location");
        const referer =
          adGate && /^https?:/i.test(adGate) ? new URL(adGate).origin + "/" : u.origin + "/";
        log(`got ${first.status}${adGate ? `, ad gate: ${new URL(adGate).hostname}` : ""}`);

        // Step 2: re-fetch with cookies + ad-gate referer to get the real countdown page.
        // The server sets a new csrfToken cookie here that must match the form's _csrfToken.
        log("refetching with cookies + referer to receive countdown form");
        const second = await fetchWithTimeout(url, {
          method: "GET",
          headers: { Cookie: cookieHeader(), Referer: referer },
          ...via,
        });
        if (blocked(second.status)) {
          log(`refetch refused with ${second.status} (IP block)`);
          return BLOCKED;
        }
        merge(second);
        if (!second.ok) {
          log(`refetch failed (${second.status})`);
          return null;
        }
        const html = await second.text();

        // The link page comes in two template variants, both with a CakePHP form
        // (id="go-link") that posts to /links/go:
        //   • Old (urlshortx.io): the form's locked security field is "ad_form_data".
        //   • New (linkshortx.in): the locked field is a random per-render hidden
        //     input, and an on-load XHR must first "arm" the link by POSTing that
        //     same form to /links/arm before /links/go will accept it.
        // Either way, submit the EXACT inputs of the go-link form — echoing back any
        // random fields — so the SecurityComponent token validates (a hardcoded list
        // drops the random field and gets the request black-holed with a 400).
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
          Origin: u.origin,
          Referer: url,
          Cookie: cookieHeader(),
        });

        // Step 3 (new template only): arm the link. The browser fires this XHR on
        // page load; /links/go stays black-holed until it succeeds. Detect the
        // endpoint in the page so the old single-step template just skips it.
        if (/\/links\/arm\b/.test(html)) {
          log("arming link (POST /links/arm) before countdown");
          const armRes = await fetchWithTimeout(`${u.origin}/links/arm`, {
            method: "POST",
            headers: postHeaders(),
            body,
            ...via,
          });
          merge(armRes);
          log(`arm returned ${armRes.status}`);
        }

        // The countdown is server-enforced (measured from arm / page load). Read it
        // from app_vars and wait, otherwise the POST returns "Bad Request."
        let counterValue = 5;
        const cm = html.match(/"counter_value"\s*:\s*(\d+)/);
        if (cm) counterValue = Math.min(parseInt(cm[1], 10) || 5, 30);
        log(`countdown is server-enforced; waiting ${counterValue + 1}s before submitting form`);
        await new Promise((r) => setTimeout(r, (counterValue + 1) * 1000));

        // Step 4: POST the go-link form to /links/go with cookies + same-origin referer.
        log(`POST ${u.origin}/links/go with CSRF + security token`);
        const r = await fetchWithTimeout(`${u.origin}/links/go`, {
          method: "POST",
          headers: postHeaders(),
          body,
          ...via,
        });
        if (!r.ok) {
          log(`POST returned ${r.status}, aborting`);
          return null;
        }
        const data = await r.json().catch(() => null);
        if (data && data.status === "error") {
          log(`server rejected POST: ${data.message || "unknown"}`);
          return null;
        }
        if (data && data.url) {
          log(`server returned destination: ${data.url}`);
          return data.url;
        }
        log("response did not contain a url");
        return null;
      }
    },
  },
];
