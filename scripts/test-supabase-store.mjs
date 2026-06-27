// Smoke test for the Supabase durable store.
// Usage: load .env then run — node --env-file=.env scripts/test-supabase-store.mjs
// Verifies a full add -> has -> get -> remove round-trip against passlink_kv.

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const TABLE = process.env.SUPABASE_KV_TABLE || "passlink_kv";

if (!URL || !KEY) {
  console.error("✖ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}

const base = `${URL.replace(/\/$/, "")}/rest/v1/${TABLE}`;
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const eq = (v) => `eq.${encodeURIComponent(v)}`;
const testId = "-100test_smoke";

async function req(url, init) {
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers || {}) } });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => "")}`);
  return res;
}

try {
  // add (upsert)
  await req(base, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ coll: "groups", id: testId, data: { id: testId, addedAt: Date.now() } }),
  });
  console.log("✓ add");

  // has
  const hasRows = await (await req(`${base}?select=id&coll=${eq("groups")}&id=${eq(testId)}&limit=1`)).json();
  if (hasRows.length !== 1) throw new Error("has returned wrong count");
  console.log("✓ has");

  // get
  const getRows = await (await req(`${base}?select=data&coll=${eq("groups")}&id=${eq(testId)}&limit=1`)).json();
  if (getRows[0]?.data?.id !== testId) throw new Error("get returned wrong data");
  console.log("✓ get");

  // remove
  const delRows = await (await req(`${base}?coll=${eq("groups")}&id=${eq(testId)}`, {
    method: "DELETE",
    headers: { Prefer: "return=representation" },
  })).json();
  if (delRows.length !== 1) throw new Error("remove returned wrong count");
  console.log("✓ remove");

  console.log("\n✅ Supabase durable store works — approvals will now persist.");
} catch (e) {
  console.error("\n✖ Supabase store test FAILED:", e.message);
  process.exit(1);
}
