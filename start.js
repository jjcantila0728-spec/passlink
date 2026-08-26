// Homelab entrypoint: HTTP server + Telegram long poller in one process.
//
// There is no public HTTPS ingress in the lab, so the bot pulls updates via
// getUpdates instead of receiving webhooks. The Express app still runs for the
// web UI and /api/bypass on the LAN.
//
// Env must load BEFORE lib/telegram.js is evaluated — that module reads
// TELEGRAM_BOT_TOKEN at module scope, and static imports are hoisted above
// any statement in this file. Hence the dynamic imports below.
import { loadEnv } from "./lib/env.js";

loadEnv();

await import("./server.js");
const { startPolling } = await import("./lib/poller.js");

const stopPolling = startPolling();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[passlink] ${signal} — shutting down`);
    stopPolling();
    // Give the in-flight update a moment to finish before the runtime exits.
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
