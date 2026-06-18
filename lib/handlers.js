// Site-specific handlers for shorteners that need more than a redirect chain.
// Each handler returns the *next* URL to follow (the generic engine continues from there).

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
    async resolve(url, { fetchWithTimeout, onNote }) {
      const log = (m) => typeof onNote === "function" && onNote(`  [urlshortx] ${m}`);
      const u = new URL(url);
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
      log("priming session (GET, expect 307 to ad gate)");
      const first = await fetchWithTimeout(url, { method: "GET" });
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
      });
      merge(second);
      if (!second.ok) {
        log(`refetch failed (${second.status})`);
        return null;
      }
      const html = await second.text();

      // The countdown is server-enforced. Read it from app_vars and wait that long,
      // otherwise the POST returns {"status":"error","message":"Bad Request."}.
      let counterValue = 5;
      const cm = html.match(/"counter_value"\s*:\s*(\d+)/);
      if (cm) counterValue = Math.min(parseInt(cm[1], 10) || 5, 30);
      log(`countdown is server-enforced; waiting ${counterValue + 1}s before submitting form`);
      await new Promise((r) => setTimeout(r, (counterValue + 1) * 1000));

      const grab = (name) => {
        const escaped = name.replace(/[\[\]]/g, (m) => "\\" + m);
        const re = new RegExp(
          'name="' + escaped + '"\\s+(?:autocomplete="off"\\s+)?value="([^"]+)"'
        );
        const m = html.match(re);
        return m ? m[1] : null;
      };
      const fields = {
        _method: grab("_method") || "POST",
        _csrfToken: grab("_csrfToken"),
        ad_form_data: grab("ad_form_data"),
        "_Token[fields]": grab("_Token[fields]"),
        "_Token[unlocked]": grab("_Token[unlocked]"),
      };
      if (!fields._csrfToken || !fields.ad_form_data) {
        log("form fields not found on page, aborting");
        return null;
      }

      const body = new URLSearchParams(fields).toString();

      // Step 3: POST to /links/go with cookies + same-origin referer.
      log(`POST ${u.origin}/links/go with CSRF token + ad_form_data`);
      const r = await fetchWithTimeout(`${u.origin}/links/go`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
          Origin: u.origin,
          Referer: url,
          Cookie: cookieHeader(),
        },
        body,
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
    },
  },
];
