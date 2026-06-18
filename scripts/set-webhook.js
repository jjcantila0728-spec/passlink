// Register (or delete) the Telegram webhook.
//
//   node scripts/set-webhook.js https://your-app.vercel.app
//   node scripts/set-webhook.js --info          # show current webhook status
//   node scripts/set-webhook.js --delete        # remove webhook (e.g. to use polling)
//
// The webhook path is "/api/telegram". Reads TELEGRAM_BOT_TOKEN and
// (optionally) TELEGRAM_WEBHOOK_SECRET from .env / environment.

import { loadEnv } from "../lib/env.js";

loadEnv();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set (.env or environment).");
  process.exit(1);
}

const api = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;
const arg = process.argv[2];

async function main() {
  if (arg === "--info") {
    const res = await fetch(api("getWebhookInfo"));
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }

  if (arg === "--delete") {
    const res = await fetch(api("deleteWebhook"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drop_pending_updates: true }),
    });
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }

  if (!arg || !/^https?:\/\//i.test(arg)) {
    console.error("Usage: node scripts/set-webhook.js <https-base-url> | --info | --delete");
    process.exit(1);
  }

  const url = `${arg.replace(/\/$/, "")}/api/telegram`;
  const payload = { url, allowed_updates: ["message", "edited_message"] };
  if (SECRET) payload.secret_token = SECRET;

  const res = await fetch(api("setWebhook"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
  if (data.ok) console.log(`\nWebhook set to: ${url}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
