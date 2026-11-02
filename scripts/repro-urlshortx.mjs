// Resolve one UrlShortx-family link the way the Telegram bot does.
//   node scripts/repro-urlshortx.mjs https://UrlShortx.io/DYgAE3d7
//
// Direct fetches from a datacenter IP are 403. Set PASSLINK_PROXY_URL to an
// HTTP proxy that is not on Hostinger's VPN list, or leave autoharvest on.

import { bypass } from "../lib/bypass.js";

const url = process.argv[2] || "https://UrlShortx.io/DYgAE3d7";
try {
  const result = await bypass(url, {
    skipCache: true,
    onNote: (note) => console.log(note),
  });
  console.log("\nFINAL", result.finalUrl);
  console.log(`hops=${result.hops} elapsedMs=${result.elapsedMs}`);
} catch (err) {
  console.error("\nFAILED", err.message);
  process.exit(1);
}
