// Telegram bot integration for PassLink.
//
// Behavior: an authorized user sends a (shortened / ad-gated) link to the bot,
// the bot runs the bypass engine and replies with the final destination link.
//
// Access control:
//   - Admin chat IDs come from TELEGRAM_ADMIN_CHAT_IDS (comma separated). Always allowed.
//   - Admins add/remove regular users at runtime via /add, /remove, /list.
//   - Anyone not in either set is refused (and told their own chat ID for onboarding).
//
// Persistence of the dynamic allowlist mirrors lib/storage.js:
//   Upstash/Vercel-KV -> file -> in-memory.

import fs from "node:fs/promises";
import path from "node:path";
import { bypass } from "./bypass.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

const ADMIN_IDS = new Set(
  (process.env.TELEGRAM_ADMIN_CHAT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ALLOW_KEY = "passlink:tg:allow"; // hash: chatId -> JSON({id, addedAt, addedBy})

export function isConfigured() {
  return Boolean(BOT_TOKEN);
}

export function getWebhookSecret() {
  return WEBHOOK_SECRET;
}

// --- Allowlist store ---------------------------------------------------------

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
  return (await res.json()).result;
}

function kvStore() {
  return {
    name: "upstash-kv",
    async list() {
      const result = await kvCall(["HVALS", ALLOW_KEY]);
      if (!Array.isArray(result)) return [];
      return result
        .map((v) => {
          try { return JSON.parse(v); } catch { return null; }
        })
        .filter(Boolean);
    },
    async has(id) {
      const v = await kvCall(["HGET", ALLOW_KEY, id]);
      return Boolean(v);
    },
    async add(entry) {
      await kvCall(["HSET", ALLOW_KEY, entry.id, JSON.stringify(entry)]);
    },
    async remove(id) {
      const r = await kvCall(["HDEL", ALLOW_KEY, id]);
      return r > 0;
    },
  };
}

function fileStore(filePath) {
  let cache = null;
  async function load() {
    if (cache) return cache;
    try {
      const data = JSON.parse(await fs.readFile(filePath, "utf8"));
      cache = new Map(Object.entries(data.users || {}));
    } catch (e) {
      if (e.code !== "ENOENT") console.warn("[passlink-tg] store read error:", e.message);
      cache = new Map();
    }
    return cache;
  }
  async function save() {
    const obj = Object.fromEntries(cache);
    await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
    await fs.writeFile(filePath, JSON.stringify({ users: obj }, null, 2));
  }
  return {
    name: `file(${filePath})`,
    async list() {
      return Array.from((await load()).values());
    },
    async has(id) {
      return (await load()).has(id);
    },
    async add(entry) {
      (await load()).set(entry.id, entry);
      await save();
    },
    async remove(id) {
      const m = await load();
      const had = m.delete(id);
      if (had) await save();
      return had;
    },
  };
}

function memoryStore() {
  const m = new Map();
  return {
    name: "memory",
    async list() { return Array.from(m.values()); },
    async has(id) { return m.has(id); },
    async add(entry) { m.set(entry.id, entry); },
    async remove(id) { return m.delete(id); },
  };
}

function pickStore() {
  if (KV_URL && KV_TOKEN) return kvStore();
  if (process.env.TELEGRAM_DATA_FILE) return fileStore(process.env.TELEGRAM_DATA_FILE);
  if (process.env.VERCEL) return fileStore("/tmp/passlink-tg.json");
  return fileStore(path.resolve(process.cwd(), ".passlink-tg.json"));
}

const store = pickStore();

// --- Telegram API ------------------------------------------------------------

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.warn(`[passlink-tg] ${method} failed:`, data.description || res.status);
  }
  return data;
}

async function sendMessage(chatId, text) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: false,
  });
}

export { tg };

// --- Authorization -----------------------------------------------------------

function isAdmin(id) {
  return ADMIN_IDS.has(String(id));
}

async function isAuthorized(id) {
  return isAdmin(id) || (await store.has(String(id)));
}

// --- Link extraction ---------------------------------------------------------

function extractUrl(text) {
  const explicit = text.match(/https?:\/\/\S+/i);
  if (explicit) return explicit[0];
  // Bare domain like "bit.ly/abc" — normalizeUrl() in bypass adds the scheme.
  const bare = text.match(/\b[\w-]+(?:\.[\w-]+)+(?:\/\S*)?/);
  return bare ? bare[0] : null;
}

// --- Command help ------------------------------------------------------------

const USER_HELP = [
  "🔓 PassLink Bot",
  "",
  "Send me a shortened or ad-gated link and I'll reply with the final destination.",
  "",
  "Commands:",
  "/whoami — show your chat ID",
  "/help — this message",
].join("\n");

function adminHelp() {
  return [
    USER_HELP,
    "",
    "Admin commands:",
    "/add <chat_id> — authorize a user",
    "/remove <chat_id> — revoke a user",
    "/list — list authorized users",
  ].join("\n");
}

// --- Update handler ----------------------------------------------------------

export async function handleUpdate(update) {
  const message = update?.message || update?.edited_message;
  const text = message?.text;
  const chatId = message?.chat?.id;
  if (!chatId || typeof text !== "string") return;

  const trimmed = text.trim();
  const admin = isAdmin(chatId);

  // /whoami and /help/start are available to everyone (useful for onboarding).
  if (/^\/whoami\b/i.test(trimmed)) {
    await sendMessage(chatId, `Your chat ID is: ${chatId}`);
    return;
  }
  if (/^\/(start|help)\b/i.test(trimmed)) {
    await sendMessage(chatId, admin ? adminHelp() : USER_HELP);
    return;
  }

  // Admin-only management commands.
  if (/^\/(add|remove|list)\b/i.test(trimmed)) {
    if (!admin) {
      await sendMessage(chatId, "⛔ Admin only.");
      return;
    }
    await handleAdminCommand(chatId, trimmed);
    return;
  }

  // Everything else is treated as a bypass request — gated by authorization.
  if (!(await isAuthorized(chatId))) {
    await sendMessage(
      chatId,
      `⛔ Not authorized.\nYour chat ID is: ${chatId}\nAsk an admin to add you.`,
    );
    return;
  }

  const url = extractUrl(trimmed);
  if (!url) {
    await sendMessage(chatId, "Send me a link to bypass, or /help for commands.");
    return;
  }

  await sendMessage(chatId, "⏳ Bypassing…");
  try {
    const result = await bypass(url);
    await sendMessage(
      chatId,
      `✅ Destination:\n${result.finalUrl}\n\n(${result.hops} hop${result.hops === 1 ? "" : "s"}, ${result.elapsedMs}ms)`,
    );
  } catch (err) {
    await sendMessage(chatId, `❌ Failed: ${err?.message || String(err)}`);
  }
}

async function handleAdminCommand(chatId, text) {
  const [cmd, arg] = text.split(/\s+/);

  if (/^\/list$/i.test(cmd)) {
    const users = await store.list();
    const adminList = [...ADMIN_IDS].map((id) => `• ${id} (admin, env)`);
    const userList = users
      .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))
      .map((u) => `• ${u.id}`);
    const lines = [...adminList, ...userList];
    await sendMessage(
      chatId,
      lines.length ? `Authorized:\n${lines.join("\n")}` : "No users authorized yet.",
    );
    return;
  }

  const id = (arg || "").trim();
  if (!/^-?\d+$/.test(id)) {
    await sendMessage(chatId, `Usage: ${cmd} <chat_id>\nExample: ${cmd} 123456789`);
    return;
  }

  if (/^\/add$/i.test(cmd)) {
    if (isAdmin(id)) {
      await sendMessage(chatId, `${id} is already an admin.`);
      return;
    }
    await store.add({ id, addedAt: Date.now(), addedBy: String(chatId) });
    await sendMessage(chatId, `✅ Added ${id}.`);
    return;
  }

  if (/^\/remove$/i.test(cmd)) {
    if (isAdmin(id)) {
      await sendMessage(chatId, `Cannot remove an admin (set via env var).`);
      return;
    }
    const had = await store.remove(id);
    await sendMessage(chatId, had ? `✅ Removed ${id}.` : `${id} was not in the list.`);
    return;
  }
}
