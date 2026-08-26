// Production long-polling runner.
//
// Unlike scripts/bot-poll.js (a dev helper), this is what runs in the homelab:
// there is no public HTTPS endpoint, so getUpdates is the only delivery path.
// It deletes any registered webhook first — Telegram refuses to serve
// getUpdates while a webhook is set — then loops with backoff until stopped.

import { handleUpdate, isConfigured } from "./telegram.js";

// Update kinds handleUpdate() actually understands. Narrowing this keeps
// Telegram from queueing types we would only drop on the floor.
const ALLOWED_UPDATES = ["message", "edited_message", "my_chat_member"];

const LONG_POLL_SECONDS = 30;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;

const api = (method) =>
  `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;

async function call(method, body, timeoutMs) {
  const res = await fetch(api(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

export function startPolling() {
  if (!isConfigured()) {
    console.warn("[passlink-poll] TELEGRAM_BOT_TOKEN not set — poller disabled.");
    return () => {};
  }

  let running = true;
  let offset = 0;
  let backoff = MIN_BACKOFF_MS;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    // Drop the Vercel webhook. drop_pending_updates stays false so anything
    // Telegram queued during the cutover is still delivered to us.
    try {
      const del = await call("deleteWebhook", { drop_pending_updates: false }, 15000);
      console.log(
        del.ok
          ? "[passlink-poll] webhook cleared — switching to getUpdates"
          : `[passlink-poll] deleteWebhook failed: ${del.description}`,
      );
    } catch (err) {
      console.warn("[passlink-poll] deleteWebhook error:", err.message);
    }

    console.log("[passlink-poll] polling for updates");

    while (running) {
      try {
        // Allow the server's 30s long poll to finish before the client aborts.
        const data = await call(
          "getUpdates",
          { offset, timeout: LONG_POLL_SECONDS, allowed_updates: ALLOWED_UPDATES },
          (LONG_POLL_SECONDS + 15) * 1000,
        );

        if (!data.ok) {
          // 409 means another process (or a re-registered webhook) is consuming
          // this bot's updates. Backing off avoids two runners fighting.
          console.warn(`[passlink-poll] getUpdates ${data.error_code}: ${data.description}`);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          continue;
        }

        backoff = MIN_BACKOFF_MS;

        for (const update of data.result) {
          // Advance the offset before handling: a message that makes
          // handleUpdate throw must not be redelivered forever.
          offset = update.update_id + 1;
          try {
            await handleUpdate(update);
          } catch (err) {
            console.error(`[passlink-poll] handleUpdate ${update.update_id} failed:`, err);
          }
        }
      } catch (err) {
        if (!running) break;
        console.warn("[passlink-poll] poll error:", err.message);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }

    console.log("[passlink-poll] stopped");
  })();

  return () => {
    running = false;
  };
}
