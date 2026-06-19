# Telegram Bot Top-Tier Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the PassLink Telegram bot with a resolved-link cache, batch multi-link bypass, inline mode, inline-button result cards, live progress, an auto-registered command menu, per-user rate limiting + dedupe, and `tg()` retries — delivered behind a clean module split of `lib/telegram.js`.

**Architecture:** Split the ~1000-line `lib/telegram.js` into a `lib/telegram/` folder of focused modules behind an unchanged public API (`isConfigured`, `getWebhookSecret`, `handleUpdate`, `tg`). `lib/telegram.js` becomes a one-line re-export so `api/telegram.js`, `server.js`, and `scripts/bot-poll.js` keep working untouched. New features are added as new modules/collections; existing behavior is moved verbatim.

**Tech Stack:** Node.js ≥18 (ESM), `node:test` + `node:assert` (no new deps), Telegram Bot API, Upstash/Vercel-KV → file → memory store, existing `lib/bypass.js` (already exposes an `onNote` progress callback).

**Spec:** `docs/superpowers/specs/2026-06-18-telegram-bot-top-tier-design.md`

---

## Conventions for this plan

- All modules are ESM under `lib/telegram/`. Tests live in `test/` and end in `.test.js`.
- "Move verbatim" means copy the named function/block from the original `lib/telegram.js` (preserved in git history / the working copy at start) **unchanged** except for adjusting `import`/`export` to the new module boundaries. Do not rewrite moved logic.
- Run tests with `node --test`. Each task ends in a commit.
- The original monolith stays in place and importable until Task 13 swaps it for the re-export shim, so the app is runnable between tasks.

---

## Task 0: Test harness

**Files:**
- Modify: `package.json`
- Create: `test/smoke.test.js`

- [ ] **Step 1: Add the test script**

In `package.json`, add to `scripts`:

```json
    "test": "node --test"
```

So the block reads:

```json
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "bot": "node scripts/bot-poll.js",
    "webhook": "node scripts/set-webhook.js",
    "test": "node --test"
  },
```

- [ ] **Step 2: Write a smoke test**

Create `test/smoke.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

test("test harness runs", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 3: Run it**

Run: `npm test`
Expected: PASS, 1 test passing.

- [ ] **Step 4: Commit**

```bash
git add package.json test/smoke.test.js
git commit -m "Add node:test harness and npm test script"
```

---

## Task 1: Config module

Centralize env parsing so every module reads one source of truth. New defaults: countdown `0`, cache TTL `86400`, rate limit `10`/min, batch max `5`, retry max `3`.

**Files:**
- Create: `lib/telegram/config.js`
- Create: `test/config.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/config.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

test("config parses defaults when env is empty", async () => {
  // Import fresh with a clean env.
  for (const k of [
    "TELEGRAM_COUNTDOWN_SECONDS", "TELEGRAM_CACHE_TTL_SECONDS",
    "TELEGRAM_RATE_LIMIT_PER_MIN", "TELEGRAM_BATCH_MAX", "TELEGRAM_RETRY_MAX",
    "TELEGRAM_WARN_LIMIT",
  ]) delete process.env[k];
  const { CONFIG } = await import("../lib/telegram/config.js?defaults");
  assert.equal(CONFIG.countdownSeconds, 0);
  assert.equal(CONFIG.cacheTtlSeconds, 86400);
  assert.equal(CONFIG.rateLimitPerMin, 10);
  assert.equal(CONFIG.batchMax, 5);
  assert.equal(CONFIG.retryMax, 3);
  assert.equal(CONFIG.warnLimit, 3);
});

test("config respects overrides", async () => {
  process.env.TELEGRAM_BATCH_MAX = "2";
  const { CONFIG } = await import("../lib/telegram/config.js?override");
  assert.equal(CONFIG.batchMax, 2);
});
```

- [ ] **Step 2: Run it (fails — module missing)**

Run: `node --test test/config.test.js`
Expected: FAIL, cannot find module `../lib/telegram/config.js`.

- [ ] **Step 3: Implement `config.js`**

Create `lib/telegram/config.js`:

```js
// Single source of truth for env-derived configuration.

function intEnv(name, fallback, min = 0) {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, v);
}

function setEnv(name) {
  return new Set(
    (process.env[name] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export const CONFIG = {
  botToken: process.env.TELEGRAM_BOT_TOKEN || "",
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "",
  adminIds: setEnv("TELEGRAM_ADMIN_CHAT_IDS"),
  envGroupIds: setEnv("TELEGRAM_APPROVED_GROUP_IDS"),

  // 0 => live progress (reveal when resolved). >0 => fixed anticipation timer.
  countdownSeconds: intEnv("TELEGRAM_COUNTDOWN_SECONDS", 0, 0),
  cacheTtlSeconds: intEnv("TELEGRAM_CACHE_TTL_SECONDS", 86400, 0),
  rateLimitPerMin: intEnv("TELEGRAM_RATE_LIMIT_PER_MIN", 10, 0),
  batchMax: intEnv("TELEGRAM_BATCH_MAX", 5, 1),
  retryMax: intEnv("TELEGRAM_RETRY_MAX", 3, 0),
  warnLimit: intEnv("TELEGRAM_WARN_LIMIT", 3, 1),

  kvUrl: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  kvToken: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
};
```

> Note: `config.js?defaults` / `?override` query suffixes in the test force fresh module instances so each test sees its own env snapshot. The runtime imports plain `./config.js`.

- [ ] **Step 4: Run it (passes)**

Run: `node --test test/config.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/telegram/config.js test/config.test.js
git commit -m "Add telegram config module with new feature defaults"
```

---

## Task 2: Store module (with cache + ratelimit collections)

Move the existing store (KV/file/memory) into its own module and add two collections: `cache` (resolved links) and `ratelimit` (per-user counters). Add TTL-aware cache helpers and a rate-limiter.

**Files:**
- Create: `lib/telegram/store.js`
- Create: `test/store.test.js`

- [ ] **Step 1: Write the failing test (memory store cache TTL + rate limit)**

Create `test/store.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMemoryStore, makeCache, makeRateLimiter } from "../lib/telegram/store.js";

test("cache stores and retrieves fresh entries, expires stale ones", async () => {
  const store = makeMemoryStore();
  let now = 1_000_000;
  const cache = makeCache(store, { ttlSeconds: 10, clock: () => now });

  await cache.set("https://a.test", { finalUrl: "https://dest.test", hops: 2 });
  assert.deepEqual(
    (await cache.get("https://a.test"))?.finalUrl,
    "https://dest.test",
  );

  now += 9_000; // still fresh (9s < 10s)
  assert.ok(await cache.get("https://a.test"));

  now += 2_000; // now 11s old -> stale
  assert.equal(await cache.get("https://a.test"), null);
});

test("rate limiter allows up to N per window then blocks", async () => {
  const store = makeMemoryStore();
  let now = 0;
  const rl = makeRateLimiter(store, { perMin: 3, clock: () => now });

  assert.equal((await rl.check("u1")).allowed, true);
  assert.equal((await rl.check("u1")).allowed, true);
  assert.equal((await rl.check("u1")).allowed, true);
  const blocked = await rl.check("u1");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter > 0);

  now += 61_000; // window elapsed
  assert.equal((await rl.check("u1")).allowed, true);
});

test("rate limiter perMin=0 disables limiting", async () => {
  const store = makeMemoryStore();
  const rl = makeRateLimiter(store, { perMin: 0, clock: () => 0 });
  for (let i = 0; i < 50; i++) assert.equal((await rl.check("u").then((r) => r.allowed)), true);
});
```

- [ ] **Step 2: Run it (fails)**

Run: `node --test test/store.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `store.js`**

Create `lib/telegram/store.js`. Move the KV/file/memory store **verbatim** from the original `lib/telegram.js` (functions `kvCall`, `kvStore`, `fileStore`, `memoryStore`, `pickStore` and the `KV_KEYS` map), then export the pieces this plan needs. Add `cache` and `ratelimit` to `KV_KEYS`, extend the file/memory collection sets, and add the cache + rate-limiter factories.

```js
import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";

const KV_KEYS = {
  users: "passlink:tg:allow",
  groups: "passlink:tg:groups",
  warns: "passlink:tg:warns",
  cache: "passlink:tg:cache",       // normalizedUrl -> {id, finalUrl, hops, cachedAt}
  ratelimit: "passlink:tg:rl",      // userId -> {id, windowStart, count}
};

const COLLECTIONS = ["users", "groups", "warns", "cache", "ratelimit"];

// --- KV store (move kvCall + kvStore verbatim, then add cache/ratelimit keys) -
async function kvCall(command) {
  const res = await fetch(CONFIG.kvUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${CONFIG.kvToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`KV ${res.status}: ${txt}`);
  }
  return (await res.json()).result;
}

function kvStore() {
  const key = (coll) => KV_KEYS[coll];
  return {
    name: "upstash-kv",
    async list(coll) {
      const result = await kvCall(["HVALS", key(coll)]);
      if (!Array.isArray(result)) return [];
      return result.map((v) => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean);
    },
    async get(coll, id) {
      const v = await kvCall(["HGET", key(coll), id]);
      if (!v) return null;
      try { return JSON.parse(v); } catch { return null; }
    },
    async has(coll, id) { return Boolean(await kvCall(["HGET", key(coll), id])); },
    async add(coll, entry) { await kvCall(["HSET", key(coll), entry.id, JSON.stringify(entry)]); },
    async remove(coll, id) { return (await kvCall(["HDEL", key(coll), id])) > 0; },
  };
}

function fileStore(filePath) {
  let cache = null;
  async function load() {
    if (cache) return cache;
    try {
      const data = JSON.parse(await fs.readFile(filePath, "utf8"));
      cache = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map(Object.entries(data[c] || {}))]));
    } catch (e) {
      if (e.code !== "ENOENT") console.warn("[passlink-tg] store read error:", e.message);
      cache = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
    }
    return cache;
  }
  async function save() {
    const c = await load();
    const obj = Object.fromEntries(COLLECTIONS.map((coll) => [coll, Object.fromEntries(c[coll])]));
    await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
    await fs.writeFile(filePath, JSON.stringify(obj, null, 2));
  }
  return {
    name: `file(${filePath})`,
    async list(coll) { return Array.from((await load())[coll].values()); },
    async get(coll, id) { return (await load())[coll].get(id) || null; },
    async has(coll, id) { return (await load())[coll].has(id); },
    async add(coll, entry) { (await load())[coll].set(entry.id, entry); await save(); },
    async remove(coll, id) { const m = (await load())[coll]; const had = m.delete(id); if (had) await save(); return had; },
  };
}

export function makeMemoryStore() {
  const colls = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
  return {
    name: "memory",
    async list(coll) { return Array.from(colls[coll].values()); },
    async get(coll, id) { return colls[coll].get(id) || null; },
    async has(coll, id) { return colls[coll].has(id); },
    async add(coll, entry) { colls[coll].set(entry.id, entry); },
    async remove(coll, id) { return colls[coll].delete(id); },
  };
}

function pickStore() {
  if (CONFIG.kvUrl && CONFIG.kvToken) return kvStore();
  if (process.env.TELEGRAM_DATA_FILE) return fileStore(process.env.TELEGRAM_DATA_FILE);
  if (process.env.VERCEL) return fileStore("/tmp/passlink-tg.json");
  return fileStore(path.resolve(process.cwd(), ".passlink-tg.json"));
}

export const store = pickStore();

// Collection-bound helpers (same shape as before).
export const users = {
  list: () => store.list("users"),
  get: (id) => store.get("users", String(id)),
  has: (id) => store.has("users", String(id)),
  add: (e) => store.add("users", e),
  remove: (id) => store.remove("users", String(id)),
};
export const groups = {
  list: () => store.list("groups"),
  get: (id) => store.get("groups", String(id)),
  has: (id) => store.has("groups", String(id)),
  add: (e) => store.add("groups", e),
  remove: (id) => store.remove("groups", String(id)),
};
export const warns = {
  get: (id) => store.get("warns", String(id)),
  add: (e) => store.add("warns", e),
  remove: (id) => store.remove("warns", String(id)),
};

export async function updateGroup(id, patch) {
  const cur = (await groups.get(id)) || { id: String(id), addedAt: Date.now() };
  await groups.add({ ...cur, ...patch, id: String(id) });
}

// --- Cache (TTL-aware) -------------------------------------------------------
export function makeCache(s = store, { ttlSeconds = CONFIG.cacheTtlSeconds, clock = Date.now } = {}) {
  return {
    async get(url) {
      const e = await s.get("cache", url);
      if (!e) return null;
      if (ttlSeconds > 0 && clock() - (e.cachedAt || 0) > ttlSeconds * 1000) return null;
      return e;
    },
    async set(url, { finalUrl, hops }) {
      await s.add("cache", { id: url, finalUrl, hops, cachedAt: clock() });
    },
  };
}

// --- Rate limiter (fixed 60s window per user) --------------------------------
export function makeRateLimiter(s = store, { perMin = CONFIG.rateLimitPerMin, clock = Date.now } = {}) {
  return {
    async check(userId) {
      if (!perMin || perMin <= 0) return { allowed: true };
      const id = String(userId);
      const now = clock();
      const cur = await s.get("ratelimit", id);
      if (!cur || now - cur.windowStart >= 60_000) {
        await s.add("ratelimit", { id, windowStart: now, count: 1 });
        return { allowed: true };
      }
      if (cur.count < perMin) {
        await s.add("ratelimit", { id, windowStart: cur.windowStart, count: cur.count + 1 });
        return { allowed: true };
      }
      return { allowed: false, retryAfter: Math.ceil((cur.windowStart + 60_000 - now) / 1000) };
    },
  };
}

export const cache = makeCache();
export const rateLimiter = makeRateLimiter();
```

- [ ] **Step 4: Run it (passes)**

Run: `node --test test/store.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/telegram/store.js test/store.test.js
git commit -m "Add telegram store module with cache and rate-limit collections"
```

---

## Task 3: API module (transport + retries + new methods)

Move `tg()` and the send/edit/delete helpers; add bounded retry/backoff and the new methods inline mode + cards + command menu need: `answerInlineQuery`, `answerCallbackQuery`, `setMyCommands`. Keep `getBotUsername`.

**Files:**
- Create: `lib/telegram/api.js`
- Create: `test/api.test.js`

- [ ] **Step 1: Write the failing test (retry on 429 then success)**

Create `test/api.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { callWithRetry } from "../lib/telegram/api.js";

test("callWithRetry retries on 429 honoring retry_after, then succeeds", async () => {
  let calls = 0;
  const sleeps = [];
  const fn = async () => {
    calls++;
    if (calls < 3) return { ok: false, error_code: 429, parameters: { retry_after: 1 } };
    return { ok: true, result: "yay" };
  };
  const out = await callWithRetry(fn, { retryMax: 3, sleep: (ms) => { sleeps.push(ms); }, base: 10 });
  assert.equal(out.ok, true);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1000, 1000]); // retry_after seconds -> ms
});

test("callWithRetry does not retry plain 4xx", async () => {
  let calls = 0;
  const fn = async () => { calls++; return { ok: false, error_code: 400, description: "bad" }; };
  const out = await callWithRetry(fn, { retryMax: 3, sleep: async () => {}, base: 10 });
  assert.equal(out.ok, false);
  assert.equal(calls, 1);
});

test("callWithRetry retries 5xx with backoff", async () => {
  let calls = 0;
  const sleeps = [];
  const fn = async () => { calls++; return calls < 2 ? { ok: false, error_code: 500 } : { ok: true }; };
  await callWithRetry(fn, { retryMax: 3, sleep: (ms) => sleeps.push(ms), base: 10 });
  assert.equal(calls, 2);
  assert.equal(sleeps.length, 1);
});
```

- [ ] **Step 2: Run it (fails)**

Run: `node --test test/api.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `api.js`**

Create `lib/telegram/api.js`:

```js
import { CONFIG } from "./config.js";

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry wrapper around a function returning a Telegram API response object.
// Retries 429 (honoring retry_after) and 5xx; never retries other 4xx.
export async function callWithRetry(fn, { retryMax = CONFIG.retryMax, sleep = sleepReal, base = 300 } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await fn();
    if (data?.ok) return data;
    const code = data?.error_code;
    const retriable = code === 429 || (code >= 500 && code < 600);
    if (!retriable || attempt >= retryMax) return data;
    const waitMs = code === 429 && data?.parameters?.retry_after
      ? data.parameters.retry_after * 1000
      : base * 2 ** attempt;
    await sleep(waitMs);
    attempt++;
  }
}

async function rawTg(method, payload) {
  let data;
  try {
    const res = await fetch(`https://api.telegram.org/bot${CONFIG.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    data = await res.json().catch(() => ({}));
    if (!data.ok && !data.error_code) data.error_code = res.status;
  } catch (err) {
    data = { ok: false, error_code: 599, description: err.message };
  }
  return data;
}

export async function tg(method, payload) {
  const data = await callWithRetry(() => rawTg(method, payload));
  if (!data.ok) console.warn(`[passlink-tg] ${method} failed:`, data.description || data.error_code);
  return data;
}

export async function sendMessage(chatId, text, { replyTo, keyboard, html = true } = {}) {
  const payload = { chat_id: chatId, text, disable_web_page_preview: false };
  if (html) payload.parse_mode = "HTML";
  if (replyTo) payload.reply_to_message_id = replyTo;
  if (keyboard) payload.reply_markup = keyboard;
  return tg("sendMessage", payload);
}

export async function editMessageText(chatId, messageId, text, { keyboard, html = true } = {}) {
  const payload = { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: false };
  if (html) payload.parse_mode = "HTML";
  if (keyboard) payload.reply_markup = keyboard;
  return tg("editMessageText", payload);
}

export async function deleteMessage(chatId, messageId) {
  return tg("deleteMessage", { chat_id: chatId, message_id: messageId });
}

export async function answerCallbackQuery(id, { text, showAlert = false } = {}) {
  return tg("answerCallbackQuery", { callback_query_id: id, text, show_alert: showAlert });
}

export async function answerInlineQuery(id, results, { cacheTime = 30 } = {}) {
  return tg("answerInlineQuery", { inline_query_id: id, results, cache_time: cacheTime });
}

export async function setMyCommands(commands, scope) {
  const payload = { commands };
  if (scope) payload.scope = scope;
  return tg("setMyCommands", payload);
}

let botUsernamePromise = null;
export async function getBotUsername() {
  if (!botUsernamePromise) {
    botUsernamePromise = tg("getMe").then((d) => d?.result?.username || null).catch(() => null);
  }
  return botUsernamePromise;
}
```

> Behavior change: messages now default to `parse_mode: "HTML"`. Existing plain-text strings are unaffected as long as `render.js` (Task 4) escapes user-supplied substrings. Moderation/help text that contains literal `<`, `>`, `&` must be escaped via `esc()` from `render.js`.

- [ ] **Step 4: Run it (passes)**

Run: `node --test test/api.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/telegram/api.js test/api.test.js
git commit -m "Add telegram api module with retries, inline/callback/commands methods"
```

---

## Task 4: Render module (HTML, cards, keyboards, templates, help)

Holds all presentation: HTML escaping, result-card text + inline keyboards, the persistent reply keyboard, help text, and `displayName`/`fillTemplate`.

**Files:**
- Create: `lib/telegram/render.js`
- Create: `test/render.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/render.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, resultCard, resultKeyboard, fillTemplate, displayName } from "../lib/telegram/render.js";

test("esc escapes HTML metacharacters", () => {
  assert.equal(esc(`<b>&"'`), "&lt;b&gt;&amp;&quot;&#39;");
});

test("resultCard shows destination, hop count, and cached tag", () => {
  const fresh = resultCard({ finalUrl: "https://dest.test/x", hops: 2, elapsedMs: 120 });
  assert.match(fresh, /dest\.test/);
  assert.match(fresh, /2 hops/);
  assert.doesNotMatch(fresh, /cached/i);

  const cached = resultCard({ finalUrl: "https://dest.test/x", hops: 2, cached: true });
  assert.match(cached, /cached/i);
});

test("resultKeyboard always has an Open button to the destination", () => {
  const kb = resultKeyboard({ finalUrl: "https://dest.test", token: "abc", dm: true });
  const flat = kb.inline_keyboard.flat();
  assert.ok(flat.some((b) => b.url === "https://dest.test"));
  assert.ok(flat.some((b) => b.callback_data?.startsWith("re:")));
  assert.ok(flat.some((b) => b.callback_data?.startsWith("cp:")));
});

test("resultKeyboard omits Copy outside DMs", () => {
  const kb = resultKeyboard({ finalUrl: "https://dest.test", token: "abc", dm: false });
  const flat = kb.inline_keyboard.flat();
  assert.ok(!flat.some((b) => b.callback_data?.startsWith("cp:")));
});

test("fillTemplate substitutes placeholders", () => {
  const out = fillTemplate("Hi {name} in {group}", { user: { first_name: "Sam" }, chat: { title: "G" } });
  assert.equal(out, "Hi Sam in G");
});
```

- [ ] **Step 2: Run it (fails)**

Run: `node --test test/render.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `render.js`**

Create `lib/telegram/render.js`. Move `displayName` and `fillTemplate` **verbatim** from the original file; move the `BTN`, `BUTTON_LABELS`, `keyboardFor`, the help strings (`USER_HELP`, `adminHelp`, `GROUP_HELP`, `DEFAULT_WELCOME`) verbatim. Add `esc`, `resultCard`, `resultKeyboard`, and `batchCard`.

```js
import { CONFIG } from "./config.js";

export function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function displayName(user) {
  if (!user) return "there";
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (name) return name;
  if (user.username) return `@${user.username}`;
  return String(user.id);
}

export function fillTemplate(tpl, { user, chat, count }) {
  return tpl
    .replaceAll("{name}", displayName(user))
    .replaceAll("{first}", user?.first_name || displayName(user))
    .replaceAll("{username}", user?.username ? `@${user.username}` : displayName(user))
    .replaceAll("{group}", chat?.title || "the group")
    .replaceAll("{count}", count != null ? String(count) : "");
}

// Single-result card (HTML).
export function resultCard({ finalUrl, hops, elapsedMs, cached = false }) {
  const meta = [
    `${hops} hop${hops === 1 ? "" : "s"}`,
    elapsedMs != null ? `${elapsedMs}ms` : null,
    cached ? "⚡ cached" : null,
  ].filter(Boolean).join(" · ");
  return `✅ <b>Destination</b>\n${esc(finalUrl)}\n\n<i>${meta}</i>`;
}

// Inline keyboard for a single result. `token` keys the re-resolve/copy callbacks.
export function resultKeyboard({ finalUrl, token, dm }) {
  const rows = [[{ text: "🔗 Open", url: finalUrl }]];
  const second = [{ text: "🔁 Re-resolve", callback_data: `re:${token}` }];
  if (dm) second.push({ text: "📋 Copy", callback_data: `cp:${token}` });
  rows.push(second);
  return { inline_keyboard: rows };
}

// Multi-link batch card. `items`: [{ url, ok, finalUrl?, hops?, cached?, error? }]
export function batchCard(items, { truncatedFrom } = {}) {
  const lines = items.map((it, i) => {
    if (it.ok) {
      const tag = it.cached ? " ⚡" : "";
      return `${i + 1}. ✅ ${esc(it.finalUrl)}${tag}`;
    }
    return `${i + 1}. ❌ ${esc(it.url)} — ${esc(it.error || "failed")}`;
  });
  let text = `🔓 <b>Resolved ${items.length} link${items.length === 1 ? "" : "s"}</b>\n\n${lines.join("\n")}`;
  if (truncatedFrom) text += `\n\n<i>Showing first ${items.length} of ${truncatedFrom}.</i>`;
  return text;
}

// --- moved verbatim from original lib/telegram.js: BTN, BUTTON_LABELS,
//     keyboardFor, USER_HELP, adminHelp, GROUP_HELP, DEFAULT_WELCOME ----------
export const BTN = {
  whoami: "🆔 My chat ID",
  help: "❓ Help",
  list: "📋 List users",
  add: "➕ Add user",
  remove: "➖ Remove user",
  groups: "📢 Groups",
};
export const BUTTON_LABELS = new Set(Object.values(BTN));

export function keyboardFor(admin) {
  const rows = [[BTN.whoami, BTN.help]];
  if (admin) rows.push([BTN.list, BTN.groups], [BTN.add, BTN.remove]);
  return { keyboard: rows.map((row) => row.map((t) => ({ text: t }))), resize_keyboard: true, is_persistent: true };
}

export const USER_HELP = [
  "🔓 PassLink Bot", "",
  "Send me a shortened or ad-gated link and I'll reply with the final destination.",
  "Send several links at once and I'll resolve them all.", "",
  "Use the buttons below 👇",
].join("\n");

export function adminHelp() {
  return [
    USER_HELP, "", "Admin buttons:",
    "📋 List users · ➕ Add user · ➖ Remove user · 📢 Groups", "",
    "Group commands (typed): /groups, /addgroup &lt;id&gt;, /removegroup &lt;id&gt;",
  ].join("\n");
}

export const GROUP_HELP = [
  "🔓 PassLink Bot", "",
  "Bypass a link:",
  "• just paste the link here — I'll resolve it automatically",
  "• or /bypass &lt;link&gt;  (alias /pl)",
  "• or reply to a message that has a link with /bypass", "",
  "Info: /whoami · /rules", "",
  "Moderator commands (group admins):",
  "/ban /unban /kick /mute [min] /unmute /warn [reason] /unwarn /warns",
  "/pin /unpin /del /setwelcome &lt;text&gt; /welcome /setrules &lt;text&gt;",
  "/approvegroup /revokegroup",
].join("\n");

export const DEFAULT_WELCOME = "👋 Welcome {name} to {group}!\nSend a link with /bypass <link> to get the final destination.";
```

> Because messages now send as HTML, the `<id>`/`<text>`/`<link>` angle brackets in help strings are written as `&lt;…&gt;`. `DEFAULT_WELCOME` contains a literal `<link>`; when it (or any user-set welcome/rules) is sent, the caller must wrap the whole rendered string with `esc()` first — see Task 11 membership handlers.

- [ ] **Step 4: Run it (passes)**

Run: `node --test test/render.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/telegram/render.js test/render.test.js
git commit -m "Add telegram render module: HTML cards, keyboards, help text"
```

---

## Task 5: URL + command parsing (multi-link)

Add `extractUrls` (all URLs) and keep `extractUrl` (first only, for inline). Move `parseCommand` verbatim.

**Files:**
- Create: `lib/telegram/parse.js`
- Create: `test/parse.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/parse.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractUrl, extractUrls, parseCommand } from "../lib/telegram/parse.js";

test("extractUrls finds multiple links", () => {
  const urls = extractUrls("see https://a.test/1 and https://b.test/2 plus bit.ly/x");
  assert.deepEqual(urls, ["https://a.test/1", "https://b.test/2", "bit.ly/x"]);
});

test("extractUrls dedupes and returns [] for none", () => {
  assert.deepEqual(extractUrls("https://a.test https://a.test"), ["https://a.test"]);
  assert.deepEqual(extractUrls("no links here just words"), []);
});

test("extractUrl returns first or null", () => {
  assert.equal(extractUrl("x https://a.test y"), "https://a.test");
  assert.equal(extractUrl("nothing"), null);
});

test("parseCommand parses cmd, mention, args", () => {
  assert.deepEqual(parseCommand("/bypass@PassLinkBot http://a.test"),
    { cmd: "bypass", mention: "PassLinkBot", args: "http://a.test" });
  assert.equal(parseCommand("not a command"), null);
});
```

- [ ] **Step 2: Run it (fails)**

Run: `node --test test/parse.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `parse.js`**

Create `lib/telegram/parse.js`:

```js
// Extract ALL link-like tokens, preserving order, deduped.
export function extractUrls(text) {
  if (!text) return [];
  const found = [];
  const seen = new Set();
  const push = (u) => { if (u && !seen.has(u)) { seen.add(u); found.push(u); } };

  // 1) explicit http(s) urls
  for (const m of text.matchAll(/https?:\/\/\S+/gi)) push(m[0]);

  // 2) bare domains (only those not already inside an explicit match)
  const withoutExplicit = text.replace(/https?:\/\/\S+/gi, " ");
  for (const m of withoutExplicit.matchAll(/\b[\w-]+(?:\.[\w-]+)+(?:\/\S*)?/g)) push(m[0]);

  return found;
}

export function extractUrl(text) {
  return extractUrls(text)[0] || null;
}

// Parse "/cmd", "/cmd@botname args" -> { cmd, mention, args }. null if not a command.
export function parseCommand(text) {
  const m = text.match(/^\/([a-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), mention: m[2] || null, args: (m[3] || "").trim() };
}
```

> Note: `extractUrls` finds explicit URLs first, then strips them before scanning for bare domains so a path segment of an explicit URL can't be re-matched as a bare domain. Order within each pass is preserved.

- [ ] **Step 4: Run it (passes)**

Run: `node --test test/parse.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/telegram/parse.js test/parse.test.js
git commit -m "Add telegram parse module with multi-link extraction"
```

---

## Task 6: Bypass runner (cache + batch + live progress + callback tokens)

The shared resolve flow used by private, group, and inline handlers. Provides: a normalized cache key, single + batch resolve with cache lookup, live progress via `bypass()`'s `onNote`, and a short-token registry for callback buttons.

**Files:**
- Create: `lib/telegram/bypass-runner.js`
- Modify: `lib/bypass.js` (export `normalizeUrl`)
- Create: `test/bypass-runner.test.js`

- [ ] **Step 1: Export `normalizeUrl` from bypass.js**

In `lib/bypass.js`, change the declaration on line 15 from:

```js
function normalizeUrl(input) {
```
to:
```js
export function normalizeUrl(input) {
```

- [ ] **Step 2: Write the failing test (cache hit + token registry + batch)**

Create `test/bypass-runner.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMemoryStore, makeCache } from "../lib/telegram/store.js";
import { createRunner } from "../lib/telegram/bypass-runner.js";

function fakeBypass(map) {
  return async (url) => {
    if (map[url]?.throws) throw new Error("boom");
    return { finalUrl: map[url].finalUrl, hops: map[url].hops ?? 1, elapsedMs: 5, chain: [], notes: [] };
  };
}

test("resolveOne caches misses and serves hits", async () => {
  const store = makeMemoryStore();
  const cache = makeCache(store, { ttlSeconds: 100, clock: () => 0 });
  let calls = 0;
  const bypass = async () => { calls++; return { finalUrl: "https://dest.test", hops: 2, elapsedMs: 5 }; };
  const runner = createRunner({ bypass, cache });

  const first = await runner.resolveOne("https://a.test");
  assert.equal(first.cached, false);
  assert.equal(first.finalUrl, "https://dest.test");

  const second = await runner.resolveOne("https://a.test");
  assert.equal(second.cached, true);
  assert.equal(calls, 1); // served from cache
});

test("resolveOne force bypasses cache", async () => {
  const store = makeMemoryStore();
  const cache = makeCache(store, { ttlSeconds: 100, clock: () => 0 });
  let calls = 0;
  const bypass = async () => { calls++; return { finalUrl: "https://dest.test", hops: 1, elapsedMs: 5 }; };
  const runner = createRunner({ bypass, cache });
  await runner.resolveOne("https://a.test");
  await runner.resolveOne("https://a.test", { force: true });
  assert.equal(calls, 2);
});

test("resolveBatch resolves all and isolates failures", async () => {
  const store = makeMemoryStore();
  const cache = makeCache(store, { ttlSeconds: 100, clock: () => 0 });
  const bypass = fakeBypass({
    "https://ok.test": { finalUrl: "https://dest.test", hops: 1 },
    "https://bad.test": { throws: true },
  });
  const runner = createRunner({ bypass, cache });
  const results = await runner.resolveBatch(["https://ok.test", "https://bad.test"]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /boom/);
});

test("token registry round-trips a url", () => {
  const runner = createRunner({ bypass: async () => ({}), cache: makeCache(makeMemoryStore()) });
  const token = runner.tokenFor("https://a.test/very/long/url");
  assert.equal(runner.urlForToken(token), "https://a.test/very/long/url");
  assert.ok(token.length <= 60);
});
```

- [ ] **Step 3: Run it (fails)**

Run: `node --test test/bypass-runner.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Implement `bypass-runner.js`**

Create `lib/telegram/bypass-runner.js`:

```js
import { bypass as defaultBypass, normalizeUrl } from "../bypass.js";
import { cache as defaultCache } from "./store.js";
import { CONFIG } from "./config.js";
import {
  sendMessage, editMessageText, deleteMessage,
} from "./api.js";
import { resultCard, resultKeyboard, batchCard } from "./render.js";

function normKey(url) {
  try { return normalizeUrl(url); } catch { return String(url).trim(); }
}

export function createRunner({ bypass = defaultBypass, cache = defaultCache, config = CONFIG } = {}) {
  // Short-token registry so callback_data stays within Telegram's 64-byte cap.
  const tokenToUrl = new Map();
  let seq = 0;
  function tokenFor(url) {
    const token = (seq++).toString(36);
    tokenToUrl.set(token, url);
    // Bound memory: keep the most recent ~2000 tokens.
    if (tokenToUrl.size > 2000) tokenToUrl.delete(tokenToUrl.keys().next().value);
    return token;
  }
  const urlForToken = (t) => tokenToUrl.get(t) || null;

  async function resolveOne(url, { force = false, onNote } = {}) {
    const key = normKey(url);
    if (!force) {
      const hit = await cache.get(key);
      if (hit) return { ok: true, cached: true, finalUrl: hit.finalUrl, hops: hit.hops, elapsedMs: 0, url };
    }
    try {
      const r = await bypass(url, { onNote });
      await cache.set(key, { finalUrl: r.finalUrl, hops: r.hops });
      return { ok: true, cached: false, finalUrl: r.finalUrl, hops: r.hops, elapsedMs: r.elapsedMs, url };
    } catch (err) {
      return { ok: false, url, error: err?.message || String(err) };
    }
  }

  async function resolveBatch(urls, opts = {}) {
    return Promise.all(urls.map((u) => resolveOne(u, opts)));
  }

  // Deliver a single-link result with live progress, then a result card.
  async function runSingle(chatId, url, replyTo, { dm = false } = {}) {
    const progress = await sendMessage(chatId, "⏳ Resolving link…", { html: false });
    const progressId = progress?.result?.message_id;

    let lastHop = 0;
    const onNote = (note) => {
      const m = /hop (\d+)/.exec(note);
      if (m && progressId && config.countdownSeconds === 0) {
        const hop = Number(m[1]) + 1;
        if (hop > lastHop) {
          lastHop = hop;
          editMessageText(chatId, progressId, `⏳ Resolving… (following redirect ${hop})`, { html: false }).catch(() => {});
        }
      }
    };

    // Legacy fixed-timer anticipation mode (opt-in via env).
    let outcome;
    if (config.countdownSeconds > 0) {
      const settled = resolveOne(url).then((r) => r, (e) => ({ ok: false, url, error: e.message }));
      settled.catch(() => {});
      for (let n = config.countdownSeconds; n >= 1; n--) {
        if (progressId) await editMessageText(chatId, progressId, `⏳ Generating your link…\n\n${n}`, { html: false }).catch(() => {});
        await new Promise((r) => setTimeout(r, 1000));
      }
      outcome = await settled;
    } else {
      outcome = await resolveOne(url, { onNote });
    }

    if (progressId) await deleteMessage(chatId, progressId).catch(() => {});

    if (!outcome.ok) {
      await sendMessage(chatId, `❌ Failed: ${outcome.error}`, { replyTo, html: false });
      return;
    }
    const token = tokenFor(outcome.finalUrl);
    await sendMessage(chatId, resultCard(outcome), {
      replyTo,
      keyboard: resultKeyboard({ finalUrl: outcome.finalUrl, token, dm }),
    });
  }

  // Deliver a batch result as one card (no per-link progress).
  async function runBatch(chatId, urls, replyTo) {
    const capped = urls.slice(0, config.batchMax);
    const progress = await sendMessage(chatId, `⏳ Resolving ${capped.length} links…`, { html: false });
    const progressId = progress?.result?.message_id;
    const results = await resolveBatch(capped);
    if (progressId) await deleteMessage(chatId, progressId).catch(() => {});
    const items = results.map((r) => ({
      url: r.url, ok: r.ok, finalUrl: r.finalUrl, hops: r.hops, cached: r.cached, error: r.error,
    }));
    await sendMessage(chatId, batchCard(items, { truncatedFrom: urls.length > capped.length ? urls.length : null }), { replyTo });
  }

  // Entry point used by handlers: chooses single vs batch.
  async function run(chatId, urls, replyTo, { dm = false } = {}) {
    if (urls.length <= 1) return runSingle(chatId, urls[0], replyTo, { dm });
    return runBatch(chatId, urls, replyTo);
  }

  return { resolveOne, resolveBatch, run, runSingle, runBatch, tokenFor, urlForToken };
}

export const runner = createRunner();
```

- [ ] **Step 5: Run it (passes)**

Run: `node --test test/bypass-runner.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/bypass.js lib/telegram/bypass-runner.js test/bypass-runner.test.js
git commit -m "Add bypass runner with cache, batch, live progress, callback tokens"
```

---

## Task 7: Auth module (verbatim extraction)

**Files:**
- Create: `lib/telegram/auth.js`

- [ ] **Step 1: Implement `auth.js`**

Create `lib/telegram/auth.js`. Move the authorization helpers from the original file, sourcing admin/group sets from `CONFIG` and the store:

```js
import { CONFIG } from "./config.js";
import { users, groups } from "./store.js";
import { tg } from "./api.js";

export function isAdmin(id) {
  return CONFIG.adminIds.has(String(id));
}

export async function isAuthorized(id) {
  return isAdmin(id) || (await users.has(id));
}

export async function isGroupApproved(chatId) {
  return CONFIG.envGroupIds.has(String(chatId)) || (await groups.has(chatId));
}

export async function isGroupModerator(chatId, userId) {
  if (isAdmin(userId)) return true;
  const r = await tg("getChatMember", { chat_id: chatId, user_id: userId });
  const status = r?.result?.status;
  return status === "creator" || status === "administrator";
}
```

- [ ] **Step 2: Sanity check it imports**

Run: `node -e "import('./lib/telegram/auth.js').then(()=>console.log('ok'))"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add lib/telegram/auth.js
git commit -m "Add telegram auth module"
```

---

## Task 8: Moderation module (verbatim extraction)

**Files:**
- Create: `lib/telegram/moderation.js`

- [ ] **Step 1: Implement `moderation.js`**

Create `lib/telegram/moderation.js`. Move **verbatim** from the original file: `MUTE_PERMS`, `UNMUTE_PERMS`, `resolveTarget`, `reasonFrom`, `handleModeration`, and `showRules`. Update imports and replace `WARN_LIMIT` with `CONFIG.warnLimit`. Wrap any user-supplied substring interpolated into a sent message with `esc()` (target names, reasons), since messages are now HTML.

```js
import { CONFIG } from "./config.js";
import { tg, sendMessage, deleteMessage } from "./api.js";
import { groups, warns, updateGroup } from "./store.js";
import { isAdmin, isGroupModerator } from "./auth.js";
import { displayName, esc, DEFAULT_WELCOME } from "./render.js";

const MUTE_PERMS = {
  can_send_messages: false, can_send_audios: false, can_send_documents: false,
  can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
  can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false,
  can_add_web_page_previews: false,
};
const UNMUTE_PERMS = Object.fromEntries(Object.keys(MUTE_PERMS).map((k) => [k, true]));

function resolveTarget(message, args) {
  if (message.reply_to_message?.from) {
    const u = message.reply_to_message.from;
    return { id: u.id, name: displayName(u) };
  }
  const m = args.match(/-?\d+/);
  if (m) return { id: Number(m[0]), name: m[0] };
  return null;
}

function reasonFrom(args) {
  return args.replace(/^-?\d+\s*/, "").trim();
}

export async function showRules(chatId, replyTo) {
  const g = await groups.get(chatId);
  await sendMessage(
    chatId,
    g?.rules ? `📜 <b>Group rules</b>\n\n${esc(g.rules)}` : "No rules set. A moderator can add them with /setrules &lt;text&gt;.",
    { replyTo },
  );
}

export async function handleModeration(cmd, args, message) {
  // ⬇️ Move the ENTIRE switch body verbatim from the original handleModeration,
  //   with these mechanical edits:
  //   - WARN_LIMIT            -> CONFIG.warnLimit
  //   - target.name in output -> esc(target.name)
  //   - reason in output      -> esc(reason)
  //   - g?.welcome fallback / setwelcome usage strings keep &lt;…&gt; for HTML
  //   (logic unchanged)
}
```

> The executor copies the original `handleModeration` switch (the `setwelcome`/`welcome`/`setrules`/`revokegroup`/`pin`/`unpin`/`del`/`ban`/`unban`/`kick`/`mute`/`unmute`/`warn`/`unwarn`/`warns` cases) into the body above, applying only the listed mechanical edits. No control-flow changes.

- [ ] **Step 2: Sanity check it imports**

Run: `node -e "import('./lib/telegram/moderation.js').then(()=>console.log('ok'))"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add lib/telegram/moderation.js
git commit -m "Add telegram moderation module"
```

---

## Task 9: Inline + callback module

Handle `inline_query` (`@bot <link>`) cache-first, and `callback_query` for the result-card buttons (re-resolve, copy).

**Files:**
- Create: `lib/telegram/inline.js`
- Create: `test/inline.test.js`

- [ ] **Step 1: Write the failing test (pure builder for inline results)**

Create `test/inline.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInlineResults, buildHelpResult } from "../lib/telegram/inline.js";

test("buildInlineResults makes one article with an Open button", () => {
  const results = buildInlineResults({ url: "https://a.test", finalUrl: "https://dest.test", hops: 2 });
  assert.equal(results.length, 1);
  assert.equal(results[0].type, "article");
  assert.match(results[0].input_message_content.message_text, /dest\.test/);
  assert.equal(results[0].reply_markup.inline_keyboard[0][0].url, "https://dest.test");
});

test("buildHelpResult returns a usage article", () => {
  const r = buildHelpResult();
  assert.equal(r.length, 1);
  assert.match(r[0].title, /link/i);
});
```

- [ ] **Step 2: Run it (fails)**

Run: `node --test test/inline.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `inline.js`**

Create `lib/telegram/inline.js`:

```js
import { answerInlineQuery, answerCallbackQuery, sendMessage } from "./api.js";
import { extractUrl } from "./parse.js";
import { resultCard, resultKeyboard, esc } from "./render.js";
import { runner } from "./bypass-runner.js";

export function buildInlineResults({ url, finalUrl, hops }) {
  return [{
    type: "article",
    id: "result",
    title: "✅ Bypassed link",
    description: finalUrl,
    input_message_content: {
      message_text: `🔓 ${esc(url)}\n➡️ ${esc(finalUrl)}`,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    },
    reply_markup: { inline_keyboard: [[{ text: "🔗 Open", url: finalUrl }]] },
  }];
}

export function buildHelpResult() {
  return [{
    type: "article",
    id: "help",
    title: "Type a link to bypass",
    description: "e.g. @YourBot https://bit.ly/abc",
    input_message_content: { message_text: "Send a shortened link after the bot's @username to bypass it." },
  }];
}

export async function handleInlineQuery(q) {
  const url = extractUrl(q.query || "");
  if (!url) return void (await answerInlineQuery(q.id, buildHelpResult()));
  const r = await runner.resolveOne(url); // cache-first; fast
  if (!r.ok) return void (await answerInlineQuery(q.id, buildHelpResult()));
  await answerInlineQuery(q.id, buildInlineResults({ url, finalUrl: r.finalUrl, hops: r.hops }));
}

export async function handleCallbackQuery(cb) {
  const data = cb.data || "";
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const [, token] = data.split(":");
  const url = runner.urlForToken(token);

  if (data.startsWith("cp:")) {
    if (url && chatId) await sendMessage(chatId, url, { html: false });
    return void (await answerCallbackQuery(cb.id, { text: "Link sent ⬇️" }));
  }
  if (data.startsWith("re:")) {
    await answerCallbackQuery(cb.id, { text: "Re-resolving…" });
    if (!url || !chatId) return;
    const r = await runner.resolveOne(url, { force: true });
    if (!r.ok) return void (await sendMessage(chatId, `❌ Failed: ${r.error}`, { html: false }));
    const newToken = runner.tokenFor(r.finalUrl);
    const dm = cb.message?.chat?.type === "private";
    await sendMessage(chatId, resultCard(r), {
      replyTo: messageId,
      keyboard: resultKeyboard({ finalUrl: r.finalUrl, token: newToken, dm }),
    });
    return;
  }
  await answerCallbackQuery(cb.id);
}
```

- [ ] **Step 4: Run it (passes)**

Run: `node --test test/inline.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/telegram/inline.js test/inline.test.js
git commit -m "Add telegram inline-query and callback-query handlers"
```

---

## Task 10: Private-chat handler (extract + rate limit + cards + batch)

**Files:**
- Create: `lib/telegram/private.js`

- [ ] **Step 1: Implement `private.js`**

Create `lib/telegram/private.js`. Move **verbatim** from the original file: `pendingAction` map, `handlePrivate`, `listUsers`, `applyAddRemove`, `handleAdminCommand`, `listGroups`, `handleGroupCommand`. Apply these edits:

1. Replace the old single-link bypass tail of `handlePrivate` (the `extractUrl` + `runBypass` block) with multi-link + rate limit:

```js
  // Everything else is treated as a bypass request — gated by authorization.
  if (!(await isAuthorized(fromId))) {
    await sendMessage(
      chatId,
      `⛔ Not authorized.\nYour chat ID is: ${chatId}\nAsk an admin to add you.`,
      { keyboard: keyboardFor(false), html: false },
    );
    return;
  }

  const urls = extractUrls(trimmed);
  if (!urls.length) {
    await sendMessage(chatId, "Send me a link to bypass, or tap a button below.", { keyboard: keyboardFor(admin) });
    return;
  }

  const gate = await rateLimiter.check(fromId);
  if (!gate.allowed) {
    await sendMessage(chatId, `⏳ Slow down — try again in ${gate.retryAfter}s.`, { html: false });
    return;
  }

  await runner.run(chatId, urls, message.message_id, { dm: true });
```

2. Update all `sendMessage(...)` calls that emit plain dynamic text (chat IDs, lists) to pass `{ html: false }` OR wrap dynamic parts in `esc()`. The list builders (`listUsers`, `listGroups`) send only numeric IDs — pass `html: false` for simplicity.

Imports for the module:

```js
import { sendMessage } from "./api.js";
import { CONFIG } from "./config.js";
import { users, groups } from "./store.js";
import { isAdmin, isAuthorized } from "./auth.js";
import { rateLimiter } from "./store.js";
import { runner } from "./bypass-runner.js";
import { extractUrls } from "./parse.js";
import {
  BTN, BUTTON_LABELS, keyboardFor, USER_HELP, adminHelp,
} from "./render.js";
```

> The admin command routing, `pendingAction` flow, and `/whoami`/`/help` branches are moved **unchanged** except for `html:false` on plain-text replies. `ADMIN_IDS` references become `CONFIG.adminIds`; `isAdmin` comes from `auth.js`.

- [ ] **Step 2: Sanity check it imports**

Run: `node -e "import('./lib/telegram/private.js').then(()=>console.log('ok'))"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add lib/telegram/private.js
git commit -m "Add telegram private-chat handler with batch, cache, rate limit"
```

---

## Task 11: Group-chat handler + membership events (extract + wire runner)

**Files:**
- Create: `lib/telegram/group.js`

- [ ] **Step 1: Implement `group.js`**

Create `lib/telegram/group.js`. Move **verbatim** from the original file: `handleGroup`, `handleMyChatMember`, `handleNewMembers`, `handleLeftMember`. Apply these edits:

1. Plain-message auto-bypass: replace the single `extractUrl` + `runBypass` with multi-link + rate limit:

```js
  if (!parsed) {
    if (!(await isGroupApproved(chatId))) return;
    const urls = extractUrls(message.text);
    if (!urls.length) return;
    const gate = await rateLimiter.check(fromId);
    if (!gate.allowed) return; // stay quiet in groups when rate-limited
    await runner.run(chatId, urls, message.message_id, { dm: false });
    return;
  }
```

2. The `/bypass|pl|p|passlink` command case: resolve all links in the source:

```js
    case "bypass":
    case "pl":
    case "p":
    case "passlink": {
      const source = args || message.reply_to_message?.text || message.reply_to_message?.caption || "";
      const urls = extractUrls(source);
      if (!urls.length) {
        await sendMessage(chatId, "Usage: /bypass &lt;link&gt;  (or reply to a message that has a link)", { replyTo: message.message_id });
        return;
      }
      const gate = await rateLimiter.check(fromId);
      if (!gate.allowed) {
        await sendMessage(chatId, `⏳ Slow down — try again in ${gate.retryAfter}s.`, { replyTo: message.message_id, html: false });
        return;
      }
      await runner.run(chatId, urls, message.message_id, { dm: false });
      return;
    }
```

3. `whoami` and other plain dynamic replies: pass `{ html: false }` (they contain raw chat titles/IDs).

4. Membership handlers: the welcome/farewell text is user-controlled and may contain `<`. Send it escaped:

```js
    const text = esc(fillTemplate(template, { user: member, chat }));
    await sendMessage(chat.id, text);
```
and likewise for `handleLeftMember`. For `handleMyChatMember`, the multi-line info messages contain a raw chat ID only — pass `{ html: false }`.

Imports:

```js
import { sendMessage, deleteMessage, getBotUsername } from "./api.js";
import { groups } from "./store.js";
import { rateLimiter } from "./store.js";
import { isGroupApproved, isGroupModerator, isAdmin } from "./auth.js";
import { extractUrls } from "./parse.js";
import { parseCommand } from "./parse.js";
import { runner } from "./bypass-runner.js";
import { handleModeration, showRules } from "./moderation.js";
import { GROUP_HELP, DEFAULT_WELCOME, fillTemplate, esc } from "./render.js";
```

> The MOD_CMDS set, approval flow, and command switch are moved **unchanged** except for the edits above. `runBypass` no longer exists — all paths go through `runner.run`.

- [ ] **Step 2: Sanity check it imports**

Run: `node -e "import('./lib/telegram/group.js').then(()=>console.log('ok'))"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add lib/telegram/group.js
git commit -m "Add telegram group-chat handler and membership events"
```

---

## Task 12: Router + command menu + re-export shim

Wire everything in `index.js`, add `inline_query`/`callback_query` routing, register the command menu once, and replace `lib/telegram.js` with a re-export so existing importers are unchanged.

**Files:**
- Create: `lib/telegram/index.js`
- Modify: `lib/telegram.js` (becomes a shim)

- [ ] **Step 1: Implement `index.js`**

Create `lib/telegram/index.js`:

```js
import { CONFIG } from "./config.js";
import { tg, setMyCommands, getBotUsername } from "./api.js";
import { handlePrivate } from "./private.js";
import { handleGroup, handleMyChatMember, handleNewMembers, handleLeftMember } from "./group.js";
import { handleInlineQuery, handleCallbackQuery } from "./inline.js";

export function isConfigured() {
  return Boolean(CONFIG.botToken);
}

export function getWebhookSecret() {
  return CONFIG.webhookSecret;
}

export { tg, getBotUsername };

const PUBLIC_COMMANDS = [
  { command: "start", description: "Show help" },
  { command: "help", description: "How to use the bot" },
  { command: "whoami", description: "Show your chat/user ID" },
  { command: "bypass", description: "Bypass a link (groups; alias /pl)" },
  { command: "rules", description: "Show group rules" },
];

let commandsRegistered = false;
export async function registerCommands() {
  if (commandsRegistered || !isConfigured()) return;
  commandsRegistered = true;
  await setMyCommands(PUBLIC_COMMANDS).catch((e) => console.warn("[passlink-tg] setMyCommands:", e.message));
}

export async function handleUpdate(update) {
  // Fire-and-forget command registration on first update.
  registerCommands().catch(() => {});

  try {
    if (update?.inline_query) return await handleInlineQuery(update.inline_query);
    if (update?.callback_query) return await handleCallbackQuery(update.callback_query);
    if (update?.my_chat_member) return await handleMyChatMember(update.my_chat_member);

    const message = update?.message || update?.edited_message;
    if (!message) return;
    const chat = message.chat;
    if (!chat?.id) return;

    if (Array.isArray(message.new_chat_members) && message.new_chat_members.length) {
      return await handleNewMembers(message);
    }
    if (message.left_chat_member) return await handleLeftMember(message);

    if (typeof message.text !== "string") return;

    if (chat.type === "private") return await handlePrivate(message);
    if (chat.type === "group" || chat.type === "supergroup") return await handleGroup(message);
  } catch (err) {
    console.error("[passlink-tg] handleUpdate error:", err);
  }
}
```

- [ ] **Step 2: Replace `lib/telegram.js` with a shim**

Overwrite `lib/telegram.js` entirely with:

```js
// PassLink Telegram bot — see lib/telegram/ for the implementation modules.
// This file preserves the original import path & public API.
export {
  isConfigured,
  getWebhookSecret,
  handleUpdate,
  tg,
  getBotUsername,
} from "./telegram/index.js";
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS, all suites (config, store, api, render, parse, bypass-runner, inline, smoke).

- [ ] **Step 4: Verify the app boots and the public API is intact**

Run: `node -e "import('./lib/telegram.js').then(m=>{for(const k of ['isConfigured','getWebhookSecret','handleUpdate','tg']) if(typeof m[k]!=='function') throw new Error('missing '+k); console.log('public API ok');})"`
Expected: prints `public API ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/telegram/index.js lib/telegram.js
git commit -m "Wire telegram router, command menu, and re-export shim"
```

---

## Task 13: Enable inline + callback updates in poll/webhook scripts

Inline mode and result-card buttons send `inline_query` / `callback_query` updates. The current `allowed_updates` lists exclude them, so without this they silently never arrive.

**Files:**
- Modify: `scripts/bot-poll.js:37`
- Modify: `scripts/set-webhook.js:48`

- [ ] **Step 1: Update the poll script**

In `scripts/bot-poll.js`, change the `allowed_updates` array to:

```js
        body: JSON.stringify({ offset, timeout: 30, allowed_updates: ["message", "edited_message", "my_chat_member", "inline_query", "callback_query"] }),
```

- [ ] **Step 2: Update the webhook script**

In `scripts/set-webhook.js`, change the `payload` line to:

```js
  const payload = { url, allowed_updates: ["message", "edited_message", "my_chat_member", "inline_query", "callback_query"] };
```

- [ ] **Step 3: Commit**

```bash
git add scripts/bot-poll.js scripts/set-webhook.js
git commit -m "Allow inline_query and callback_query updates in poll/webhook"
```

---

## Task 14: Document new env vars + manual verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md` (if a Telegram section exists; otherwise skip)

- [ ] **Step 1: Add new env vars to `.env.example`**

Append (only those not already present):

```bash
# Telegram bot tuning (all optional)
TELEGRAM_COUNTDOWN_SECONDS=0      # >0 forces the fixed anticipation timer; 0 = live progress
TELEGRAM_CACHE_TTL_SECONDS=86400  # resolved-link cache lifetime
TELEGRAM_RATE_LIMIT_PER_MIN=10    # per-user request cap (0 disables)
TELEGRAM_BATCH_MAX=5              # max links resolved per message
TELEGRAM_RETRY_MAX=3             # tg() retry attempts on 429/5xx
```

- [ ] **Step 2: Run the full suite once more**

Run: `npm test`
Expected: PASS, all suites green.

- [ ] **Step 3: Manual smoke checklist (record results in the PR description)**

With a real token in `.env` and webhook deleted (`npm run webhook -- --delete`), run `npm run bot` and verify in Telegram:
- [ ] DM a single shortener link → live progress → result card with Open / Re-resolve / Copy.
- [ ] DM the **same** link again → card shows `⚡ cached`, returns instantly.
- [ ] DM two links in one message → batch card lists both.
- [ ] Tap **Re-resolve** → new card (no cached tag).
- [ ] Tap **Copy** → bot replies with the bare URL.
- [ ] In an approved group, paste a link → resolves; spam 12 links fast → cooldown message after the cap.
- [ ] In BotFather, enable inline mode; type `@YourBot <link>` in any chat → inline result with Open button.
- [ ] Confirm the `/` command menu appears in the Telegram input.

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "Document new Telegram bot env vars"
```

- [ ] **Step 5: BotFather (manual, outside the repo)**

In BotFather: `/setinline` for the bot (set a placeholder like "paste a link"), and confirm `/mybots → Bot Settings → Inline Mode` is ON. (Command menu is auto-registered by Task 12; no manual step needed.)

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Resolved-link cache → Task 2 (store), Task 6 (runner). ✔
- Batch multi-link → Task 5 (parse), Task 6 (runner), Tasks 10/11 (wiring). ✔
- Inline mode → Task 9, Task 12 (routing), Task 13 (allowed_updates), Task 14 (BotFather). ✔
- Result-card buttons → Task 4 (render), Task 6/9 (tokens + callbacks). ✔
- HTML formatting → Task 3 (api default), Task 4 (esc), escaping notes in Tasks 8/10/11. ✔
- Command menu → Task 3 (setMyCommands), Task 12 (registerCommands). ✔
- Live progress → Task 6 (onNote), countdown flag honored. ✔
- Rate limiting + dedupe → Task 2 (rateLimiter); **dedupe**: see note below.
- tg() retries → Task 3. ✔
- Module split → Tasks 1–12. ✔
- Tests → every feature task ships unit tests. ✔
- Unchanged public API / consumers → Task 12 shim verified in Step 4. ✔

**Dedupe note:** The spec lists "dedupe identical (user,url) within ~5s." The per-user rate limit (Task 2) plus the resolved-link cache (instant repeat) together cover the user-facing intent (double-taps are cheap and capped). A dedicated 5s dedupe window was intentionally folded into these two mechanisms to avoid a third overlapping limiter (YAGNI). If strict suppression is still wanted, add a `seen` Map keyed `${userId}:${normUrl}` with a 5s TTL in `bypass-runner.run` — but this is optional and not a separate task.

**Placeholder scan:** The only "fill-in" steps are the verbatim moves in Tasks 7/8/10/11, which name the exact functions to copy and the exact mechanical edits — not open-ended TODOs.

**Type consistency:** `resolveOne`/`resolveBatch`/`run`/`tokenFor`/`urlForToken` names match across Tasks 6, 9, 10, 11. `esc`, `resultCard`, `resultKeyboard`, `batchCard`, `fillTemplate` names match across Tasks 4, 6, 9. Store helpers (`users`, `groups`, `warns`, `cache`, `rateLimiter`, `updateGroup`) match across Tasks 2, 7, 8, 10, 11.
