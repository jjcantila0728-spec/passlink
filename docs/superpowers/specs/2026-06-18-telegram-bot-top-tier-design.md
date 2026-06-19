# PassLink Telegram Bot — Top-Tier Upgrade

**Date:** 2026-06-18
**Status:** Approved

## Goal

Upgrade the existing PassLink Telegram bot from "works" to "top-tier" across
three dimensions chosen by the user: **power features**, **UX/polish**, and
**robustness/ops**. This is additive plus a structural refactor — not a rewrite.
All existing behavior, commands, env config, storage fallback, and the Cantila
deployment stay intact.

## Confirmed Scope

**Power features**
- Resolved-link cache
- Batch multi-link bypass
- Inline mode (`@bot <link>` in any chat)

**UX / polish**
- Inline-button result cards
- HTML message formatting
- Auto-registered command menu (`setMyCommands`)
- Live progress (real stages) replacing the fake countdown by default

**Robustness / ops**
- `tg()` retry with backoff
- Per-user rate limiting + dedupe
- Structured error handling so one update can't crash the loop
- Structured logging
- A lightweight test setup (`node:test`)

**Cut (YAGNI):** QR codes, link-preview/metadata, admin analytics/dashboard,
broadcast.

## Decisions

- **Countdown:** default to live progress (resolving → hop N → done), reveal on
  completion. `TELEGRAM_COUNTDOWN_SECONDS > 0` still forces the fixed anticipation
  timer for anyone who wants it. Default value becomes `0`.
- **Rate limiting:** per-user cap (default 10/min) with a friendly cooldown
  message, plus dedupe of identical `(user, url)` requests within ~5s.
- **Batch cap:** resolve at most 5 links per message; if more are present, note
  "showing first 5".
- **Cache TTL:** 24h default (`TELEGRAM_CACHE_TTL_SECONDS`).
- **BotFather:** user controls it. Inline mode will be enabled there; the bot
  also self-registers commands via the API.

## Architecture

Split the ~1000-line `lib/telegram.js` into a `lib/telegram/` module folder with
clear seams. The public API (`isConfigured`, `getWebhookSecret`, `handleUpdate`,
`tg`) is preserved exactly so `api/telegram.js`, `server.js`, and
`scripts/bot-poll.js` need no changes. `lib/telegram.js` becomes a thin
re-export of `lib/telegram/index.js` (keeps existing import paths working).

| Module | Responsibility |
|---|---|
| `index.js` | `handleUpdate` router + public re-exports |
| `api.js` | `tg()` transport with retry/backoff; `sendMessage`, `editMessageText`, `deleteMessage`, `answerInlineQuery`, `answerCallbackQuery`, `setMyCommands`, `getBotUsername` |
| `store.js` | KV/file/memory store; collections `users`, `groups`, `warns`, **`cache`**, **`ratelimit`** |
| `auth.js` | `isAdmin`, `isAuthorized`, `isGroupApproved`, `isGroupModerator` |
| `bypass-runner.js` | shared resolve flow: cache lookup → (batch) resolve → live progress → result card |
| `private.js` | private-chat handler + admin user/group management |
| `group.js` | group-chat handler (bypass + command routing) |
| `inline.js` | inline-query + callback-query handlers |
| `moderation.js` | moderation commands |
| `render.js` | HTML formatting, result-card text + keyboards, help text, templates |
| `config.js` | env parsing + constants in one place |

## Feature Behaviors

### 1. Resolved-link cache
- New store collection `cache`, KV hash `passlink:tg:cache`.
- Key: normalized URL. Value: `{ id, finalUrl, hops, cachedAt }`.
- On lookup, entries older than the TTL are treated as misses (and may be
  overwritten on the next resolve).
- Cache hits skip the upstream `bypass()` call entirely; the result card shows a
  small `⚡ cached` tag.
- `/re-resolve` (button) and an explicit force path bypass the cache and refresh
  the entry.

### 2. Batch multi-link
- `extractUrls(text)` returns all URLs (the existing `extractUrl` becomes a
  single-result wrapper for inline mode).
- Cap at 5; if more, append a "showing first 5 of N" note.
- Resolve concurrently with `Promise.allSettled`; a single failure is reported
  inline within the card and never aborts the rest.
- Single-link messages render the existing single card (no behavior change for
  the common case).

### 3. Inline mode
- Handle `update.inline_query`: extract one URL from the query, resolve
  cache-first for latency, and `answerInlineQuery` with one article result
  containing the destination and an `Open` URL button.
- No/invalid link → a single helper result explaining usage. Never errors out.
- Empty query → helper result.

### 4. Result cards + callback buttons
- Every resolved result renders an HTML card with inline buttons:
  - **🔗 Open** — URL button to the destination.
  - **🔁 Re-resolve** — `callback_data` that re-runs the bypass ignoring cache.
  - **📋 Copy** (DM only) — replies with the bare URL for easy copy.
- `update.callback_query` routed to `inline.js`; always `answerCallbackQuery` to
  clear the client spinner.
- `callback_data` stays within Telegram's 64-byte limit (store a short token in
  the `cache`/a `callbacks` map keyed by a short id rather than the full URL).

### 5. Live progress
- `bypass-runner` sends one status message and edits it through real stages.
- If `TELEGRAM_COUNTDOWN_SECONDS > 0`, the legacy fixed countdown runs instead.
- Reveal happens as soon as the resolve settles; the status message is replaced
  by the result card (or edited into it).

### 6. Command menu
- On process start (poll script and a one-time call path for webhook),
  `setMyCommands` registers the public commands, with an admin-scoped set for
  admin chat IDs where practical.
- Idempotent and best-effort; failure only logs.

## Robustness

- `tg()`: bounded retries (default 3) with exponential backoff; on HTTP 429
  respect `retry_after`; retry 5xx; never retry 4xx (except 429). Logs each
  retry.
- Per-user rate limit via `ratelimit` collection: sliding/fixed window, default
  10 requests/min. Over-limit → one friendly cooldown reply (deduped so we don't
  spam the cooldown notice).
- Dedupe: ignore an identical `(user, normalizedUrl)` seen within ~5s.
- Every top-level handler in `handleUpdate` wrapped in try/catch with a tagged
  log; a thrown handler never breaks the update loop or the webhook 200.
- Structured logs: consistent `[passlink-tg]` prefix with update id / chat id /
  action.

## Testing

- Introduce `node:test` (no new deps) + `npm test` script.
- Unit-test pure logic with `tg` injected/mocked:
  - `extractUrls` / `extractUrl` (multi + bare domain + none)
  - `parseCommand`
  - cache TTL freshness logic
  - rate-limiter window behavior
  - dedupe window
  - `fillTemplate`
  - result-card / keyboard rendering shape
- No live network in tests.

## Non-Goals / Unchanged

- Allowlist + group-approval model, all existing commands, env var names (new
  ones added only), storage fallback chain, the public module API, and the
  Cantila deployment. The web app (`public/app.js`, `styles.css`) is out of
  scope for this work.

## New Env Vars

| Var | Default | Purpose |
|---|---|---|
| `TELEGRAM_COUNTDOWN_SECONDS` | `0` (was 5) | >0 forces legacy anticipation timer |
| `TELEGRAM_CACHE_TTL_SECONDS` | `86400` | resolved-link cache lifetime |
| `TELEGRAM_RATE_LIMIT_PER_MIN` | `10` | per-user request cap |
| `TELEGRAM_BATCH_MAX` | `5` | max links resolved per message |
| `TELEGRAM_RETRY_MAX` | `3` | `tg()` retry attempts |
