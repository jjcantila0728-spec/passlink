// Harvest free proxies, validate that they can actually reach a target that
// IP-blocks our serverless host, and store the working ones in Supabase so the
// bypasser reuses them. Run locally (or from a cron) — validation succeeds from
// anywhere because it's the *proxy's* IP that hits the target, not ours.
//
//   node scripts/refresh-proxies.mjs                       # default target
//   node scripts/refresh-proxies.mjs https://linkshortx.in/K55d
//
// Reality check: at build time a scan of ~3,900 free proxies found 0 that could
// reach linkshortx.in (dead, or themselves datacenter IPs the target blocks).
// This is the supported way to keep the pool fresh; if you have a paid
// residential proxy, just set PASSLINK_PROXY_URL instead — no scan needed.

import { loadEnv } from "../lib/env.js";

loadEnv();

const { harvestProxies, probeProxy, getStoredProxies, saveStoredProxies } =
  await import("../lib/proxies.js");
const { supabaseEnabled } = await import("../lib/supabase.js");

const target = process.argv[2] || "https://linkshortx.in/K55d";
const CONCURRENCY = 60;
const PROBE_TIMEOUT = 9000;

console.log(`[refresh-proxies] target: ${target}`);
if (!supabaseEnabled()) {
  console.warn("[refresh-proxies] Supabase not configured — results won't be stored.");
}

const pool = await harvestProxies();
console.log(`[refresh-proxies] harvested ${pool.length} candidates; probing…`);

const working = [];
let i = 0;
let done = 0;
async function worker() {
  while (i < pool.length) {
    const p = pool[i++];
    if (await probeProxy(p, target, { timeoutMs: PROBE_TIMEOUT })) {
      working.push(p);
      console.log(`  ✓ ${p}`);
    }
    if (++done % 250 === 0) console.log(`  …probed ${done}/${pool.length} (working: ${working.length})`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`[refresh-proxies] done. working: ${working.length}/${pool.length}`);

if (working.length) {
  const existing = await getStoredProxies().catch(() => []);
  const merged = [...new Set([...working, ...existing])];
  await saveStoredProxies(merged);
  console.log(`[refresh-proxies] stored ${Math.min(merged.length, 50)} proxies in Supabase.`);
} else {
  console.log("[refresh-proxies] no working proxies found — pool left unchanged.");
  console.log("  Tip: set PASSLINK_PROXY_URL to a residential proxy for a reliable fix.");
}
