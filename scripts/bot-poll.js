// Local long-polling runner — test the bot without deploying or a public URL.
//
//   node scripts/bot-poll.js
//
// Uses getUpdates (not the webhook). Make sure no webhook is registered
// (run `node scripts/set-webhook.js --delete` first), otherwise Telegram
// will not deliver updates to getUpdates.

import { loadEnv } from "../lib/env.js";

loadEnv();

const { handleUpdate, isConfigured } = await import("../lib/telegram.js");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!isConfigured()) {
  console.error("TELEGRAM_BOT_TOKEN is not set (.env or environment).");
  process.exit(1);
}

const api = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;
let offset = 0;
let running = true;

process.on("SIGINT", () => {
  running = false;
  console.log("\nStopping…");
});

async function poll() {
  console.log("PassLink bot polling for updates. Press Ctrl+C to stop.");
  while (running) {
    try {
      const res = await fetch(api("getUpdates"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset, timeout: 30, allowed_updates: ["message", "edited_message", "my_chat_member"] }),
      });
      const data = await res.json();
      if (!data.ok) {
        console.warn("getUpdates error:", data.description);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      for (const update of data.result) {
        offset = update.update_id + 1;
        const m = update.message || update.edited_message;
        if (update.my_chat_member) {
          const c = update.my_chat_member.chat;
          console.log(`← update ${update.update_id} my_chat_member in chat ${c?.id} (${c?.title || c?.type}) -> ${update.my_chat_member.new_chat_member?.status}`);
        } else {
          console.log(`← update ${update.update_id} from chat ${m?.chat?.id}: ${JSON.stringify(m?.text)}`);
        }
        handleUpdate(update).catch((e) => console.error("handleUpdate error:", e));
      }
    } catch (e) {
      console.warn("poll error:", e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  process.exit(0);
}

poll();
