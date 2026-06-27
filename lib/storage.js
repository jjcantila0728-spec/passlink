// Storage adapter for access codes.
// - On Vercel with Upstash/Vercel-KV env vars: uses the Upstash REST API (durable).
// - Else: JSON file. On Vercel without KV, falls back to /tmp (lost on cold start).
// - Else: in-memory (warns).

import fs from "node:fs/promises";
import path from "node:path";
import { supabaseEnabled, sbSelect, sbUpsert, sbDelete, eq } from "./supabase.js";

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const CODES_KEY = "passlink:codes"; // single hash storing all codes

function memoryAdapter() {
  let warned = false;
  const map = new Map();
  return {
    name: "memory",
    async list() {
      if (!warned && process.env.NODE_ENV === "production") {
        console.warn("[passlink] using in-memory storage; codes will be lost on cold start");
        warned = true;
      }
      return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt);
    },
    async get(code) {
      return map.get(code) || null;
    },
    async put(entry) {
      map.set(entry.code, entry);
    },
    async del(code) {
      return map.delete(code);
    },
  };
}

function fileAdapter(filePath) {
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const txt = await fs.readFile(filePath, "utf8");
      const data = JSON.parse(txt);
      cache = new Map(Object.entries(data.codes || {}));
    } catch (e) {
      if (e.code !== "ENOENT") console.warn("[passlink] file storage read error:", e.message);
      cache = new Map();
    }
    return cache;
  }

  async function save() {
    if (!cache) return;
    const obj = Object.fromEntries(cache);
    await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
    await fs.writeFile(filePath, JSON.stringify({ codes: obj }, null, 2));
  }

  return {
    name: `file(${filePath})`,
    async list() {
      const m = await load();
      return Array.from(m.values()).sort((a, b) => b.createdAt - a.createdAt);
    },
    async get(code) {
      const m = await load();
      return m.get(code) || null;
    },
    async put(entry) {
      const m = await load();
      m.set(entry.code, entry);
      await save();
    },
    async del(code) {
      const m = await load();
      const had = m.delete(code);
      if (had) await save();
      return had;
    },
  };
}

async function kvCall(command) {
  const res = await fetch(KV_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`KV ${res.status}: ${txt}`);
  }
  const data = await res.json();
  return data.result;
}

function kvAdapter() {
  return {
    name: "upstash-kv",
    async list() {
      const result = await kvCall(["HVALS", CODES_KEY]);
      if (!Array.isArray(result)) return [];
      const entries = result
        .map((v) => {
          try { return JSON.parse(v); } catch { return null; }
        })
        .filter(Boolean);
      return entries.sort((a, b) => b.createdAt - a.createdAt);
    },
    async get(code) {
      const v = await kvCall(["HGET", CODES_KEY, code]);
      if (!v) return null;
      try { return JSON.parse(v); } catch { return null; }
    },
    async put(entry) {
      await kvCall(["HSET", CODES_KEY, entry.code, JSON.stringify(entry)]);
    },
    async del(code) {
      const r = await kvCall(["HDEL", CODES_KEY, code]);
      return r > 0;
    },
  };
}

// Supabase Postgres adapter. Codes live in the shared passlink_kv table under
// the "codes" collection (coll='codes', id=code, data=entry) — same table the
// Telegram bot uses, and the one the pg_cron job purges of expired codes.
function supabaseAdapter() {
  const coll = "codes";
  return {
    name: "supabase",
    async list() {
      const rows = await sbSelect("passlink_kv", `?coll=${eq(coll)}&select=data`);
      return rows
        .map((r) => r.data)
        .filter(Boolean)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    async get(code) {
      const rows = await sbSelect(
        "passlink_kv",
        `?coll=${eq(coll)}&id=${eq(code)}&select=data&limit=1`,
      );
      return rows[0]?.data ?? null;
    },
    async put(entry) {
      await sbUpsert("passlink_kv", { coll, id: String(entry.code), data: entry });
    },
    async del(code) {
      try {
        const rows = await sbDelete("passlink_kv", `?coll=${eq(coll)}&id=${eq(code)}`);
        return Array.isArray(rows) && rows.length > 0;
      } catch {
        return false;
      }
    },
  };
}

function pickAdapter() {
  if (supabaseEnabled()) return supabaseAdapter();
  if (KV_URL && KV_TOKEN) return kvAdapter();

  if (process.env.PASSLINK_DATA_FILE) {
    return fileAdapter(process.env.PASSLINK_DATA_FILE);
  }
  if (process.env.VERCEL) {
    // Vercel /tmp is writable but ephemeral. Better than memory but not durable.
    return fileAdapter("/tmp/passlink-data.json");
  }
  // Local dev: write to repo dir.
  return fileAdapter(path.resolve(process.cwd(), ".passlink-data.json"));
}

export const storage = pickAdapter();
