// Unit coverage for the CakePHP urlshortx family. No network.
//   node scripts/test-urlshortx.mjs

process.env.PASSLINK_URLSHORTX_STEP_MS = "0";

import {
  extractForwardForm,
  extractSecurityForm,
  isVpnInterstitial,
  resolveUrlshortxFamily,
  urlshortxStepDwellMs,
} from "../lib/handlers.js";

let failed = 0;
function assert(cond, message) {
  if (!cond) {
    failed += 1;
    console.error("FAIL", message);
  }
}

const countdown = `
<form id="go-link" action="/links/go">
  <input name="_method" value="POST">
  <input name="_csrfToken" value="csrf&amp;1">
  <input name="f2725d5bd1554bb8c" value="tok%3A1">
  <input name="_Token[fields]" value="abc%3Af2725d5bd1554bb8c">
  <input name="_Token[unlocked]" value="">
</form>
<script>var app_vars = {"counter_value":0};</script>
`;

const fields = extractSecurityForm(countdown);
assert(fields._csrfToken === "csrf&1", "csrf html entity decoded");
assert(fields["f2725d5bd1554bb8c"] === "tok%3A1", "random security field kept verbatim");
assert(!fields.ad_form_data, "arm form is not the security form");

assert(isVpnInterstitial("<title>Access Denied</title><p>we detected the use of a proxy or VPN</p>"), "vpn interstitial");
assert(!isVpnInterstitial("<title>Access Denied</title><p>nope</p>"), "other 403 is not the refresh page");
assert(urlshortxStepDwellMs("<title>Step 2 of 4</title>") === 0, "test dwell override");
delete process.env.PASSLINK_URLSHORTX_STEP_MS;
assert(urlshortxStepDwellMs("<title>Step 2 of 4 · LinkShortX</title>") === 10000, "step pages dwell");
assert(urlshortxStepDwellMs("<title>Loading…</title><input name=\"clickarlink\">") === 0, "loading page does not dwell");
process.env.PASSLINK_URLSHORTX_STEP_MS = "0";

const fwd = extractForwardForm(
  '<form id="fwd" action="/airtel/"><input name="rtgsafelink" value="abc"></form>',
  "https://hindisink.com/step/",
);
assert(fwd.action === "https://hindisink.com/airtel/", "forward action resolved");
assert(fwd.fields.rtgsafelink === "abc", "rotating field name kept");

function response({ status = 200, headers = {}, body = "", json = null }) {
  const setCookie = headers["set-cookie"] || [];
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => headerMap.get(String(name).toLowerCase()) || null,
      getSetCookie: () => setCookie,
    },
    async text() { return body; },
    async json() { return json ?? JSON.parse(body); },
  };
}

async function run(script) {
  const seen = [];
  const fetchWithTimeout = async (target, opts = {}) => {
    seen.push({ url: target, method: opts.method || "GET", body: opts.body || "", headers: opts.headers || {}, proxy: opts.proxy || null });
    const step = script.shift();
    if (!step) throw new Error(`unexpected ${opts.method || "GET"} ${target}`);
    return step(target, opts);
  };
  const notes = [];
  const result = await resolveUrlshortxFamily("https://urlshortx.io/DYgAE3d7", {
    fetchWithTimeout,
    onNote: (n) => notes.push(n),
    isBlockStatus: (s) => s === 403 || s === 429 || s === 503,
    getProxies: async () => [],
  });
  return { result, seen, notes, leftover: script.length };
}

// Legacy clone: 307 then a referer refetch already contains #go-link. No blog.
{
  const { result, seen } = await run([
    () => response({
      status: 307,
      headers: { location: "https://hindisink.com/ad.php", "set-cookie": ["AppSession=a; path=/"] },
    }),
    () => response({ status: 200, body: countdown }),
    () => response({ status: 200, json: { status: "success", url: "https://example.com/legacy" } }),
  ]);
  assert(result === "https://example.com/legacy", `legacy path resolved, got ${result}`);
  assert(seen.length === 3, `legacy made 3 requests, got ${seen.length}`);
  assert(!seen.some((s) => s.url.includes("hindisink")), "legacy path does not fetch the blog");
}

// Current urlshortx: blog funnel, sealed ?t= page, arm, then /links/go.
{
  const { result, seen, leftover } = await run([
    () => response({
      status: 307,
      headers: { location: "https://hindisink.com/q7m4vk29.php?id=1", "set-cookie": ["AppSession=a; path=/", "refDYgAE3d7=b; path=/"] },
    }),
    () => response({ status: 307, headers: { location: "https://hindisink.com/q7m4vk29.php?id=2" } }),
    () => response({
      status: 200,
      headers: { "set-cookie": ["link=seal; path=/"] },
      body: '<script>window.location.href = "https://hindisink.com/";</script>',
    }),
    () => response({
      status: 200,
      body: '<title>Loading…</title><form id="fwd" action="https://hindisink.com/article-1/"><input name="clickarlink" value="c1"></form>',
    }),
    () => response({
      status: 200,
      body: '<title>Step 1 of 4</title><form id="fwd" action="https://hindisink.com/article-2/"><input name="newwpsafelink" value="n1"></form>',
    }),
    () => response({
      status: 200,
      body: '<title>Your link is ready</title><form action="https://hindisink.com/q7m4go.php"><input name="g" value="final"></form>',
    }),
    () => response({
      status: 302,
      headers: { location: "https://urlshortx.io/DYgAE3d7?t=sealed" },
    }),
    () => response({
      status: 200,
      headers: { "set-cookie": ["AppSession=fresh; path=/", "csrfToken=t; path=/"] },
      body: countdown + '<script>var armUrl = "/links/arm";</script>',
    }),
    (url, opts) => {
      assert(opts.headers["X-Requested-With"] === "XMLHttpRequest", "arm is an XHR");
      assert(String(opts.body).includes("f2725d5bd1554bb8c"), "arm echoes the random field");
      assert(String(opts.headers.Cookie || "").includes("AppSession=fresh"), "arm uses the sealed session, not the pre-gate one");
      return response({ status: 200, json: { status: "ok" } });
    },
    () => response({ status: 200, json: { status: "success", url: "https://telegram.me/AVFile_BOT?start=1" } }),
  ]);
  assert(leftover === 0, `funnel script not fully consumed (${leftover} left)`);
  assert(result === "https://telegram.me/AVFile_BOT?start=1", `funnel resolved, got ${result}`);
  const posts = seen.filter((s) => s.method === "POST").map((s) => s.url);
  assert(posts.includes("https://hindisink.com/article-1/"), "posted clickarlink");
  assert(posts.includes("https://hindisink.com/q7m4go.php"), "posted the seal");
  assert(posts.includes("https://urlshortx.io/links/arm"), "armed");
  assert(posts.includes("https://urlshortx.io/links/go"), "posted go");
}

// Datacenter 403 with no session is a hard block, not a fake success.
{
  const { result, notes } = await run([
    () => response({ status: 403, body: "forbidden" }),
  ]);
  assert(result === null, `hard block returns null, got ${result}`);
  assert(notes.some((n) => /IP block/.test(n)), "hard block is logged");
}

// The VPN interstitial is refreshed once before the proxy pool is involved.
{
  const { result, seen } = await run([
    () => response({
      status: 403,
      headers: { "set-cookie": ["AppSession=a; path=/"] },
      body: "<title>Access Denied</title><p>proxy or VPN</p>",
    }),
    () => response({ status: 200, body: countdown }),
    () => response({ status: 200, json: { status: "success", url: "https://example.com/refreshed" } }),
  ]);
  assert(result === "https://example.com/refreshed", `refresh path resolved, got ${result}`);
  assert(seen[1].headers.Cookie && seen[1].headers.Cookie.includes("AppSession=a"), "refresh sent the session cookie");
  assert(seen.length === 3, "refresh did not open the blog");
}

if (failed) {
  console.error(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("urlshortx handler tests passed");
