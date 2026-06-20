// Telegram bot integration for PassLink.
//
// Two ways to use the bot:
//
//   1. Private chat (DM): an authorized user sends a (shortened / ad-gated) link
//      and the bot replies with the final destination. Admins manage the per-user
//      allowlist via /add, /remove, /list.
//
//   2. Group chat: in an admin-APPROVED group, ANY member can run the /bypass
//      (alias /pl) command with a link and the bot replies in the group. The bot
//      also moderates the group: welcomes new members, and gives group admins
//      moderation commands (ban/kick/mute/warn/pin/del/rules/welcome).
//
// Access control:
//   - Admin user IDs come from TELEGRAM_ADMIN_CHAT_IDS (comma separated). Always allowed.
//   - Admins add/remove regular DM users at runtime via /add, /remove, /list.
//   - Admins approve groups via /approvegroup (run inside the group) or /addgroup
//     <id> from a DM; list/revoke with /groups, /removegroup. Groups can also be
//     pre-approved via TELEGRAM_APPROVED_GROUP_IDS (comma separated).
//   - In an approved group every member may use /bypass — no per-user step.
//   - Moderation commands work for env admins AND the group's own Telegram admins.
//
// Note: a Telegram invite link (t.me/+…) or @username is NOT the numeric chat ID
// the Bot API uses. The real group ID (a negative number) is only known once the
// bot is in the group, which is why approval happens at runtime via /approvegroup.
//
// Persistence of the dynamic allow-lists mirrors lib/storage.js:
//   Upstash/Vercel-KV -> file -> in-memory.

import fs from "node:fs/promises";
import path from "node:path";
import { bypass } from "./bypass.js";

// Anticipation countdown shown before the destination link is revealed.
// The link is NEVER sent until the countdown reaches zero AND the bypass is done.
const COUNTDOWN_SECONDS = Math.max(
  0,
  Number.parseInt(process.env.TELEGRAM_COUNTDOWN_SECONDS ?? "5", 10) || 0,
);

// Number of warnings before a member is auto-banned.
const WARN_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.TELEGRAM_WARN_LIMIT ?? "3", 10) || 3,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

const ADMIN_IDS = new Set(
  (process.env.TELEGRAM_ADMIN_CHAT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// Groups pre-approved via env (numeric chat IDs, comma separated).
const ENV_GROUP_IDS = new Set(
  (process.env.TELEGRAM_APPROVED_GROUP_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// One KV hash per collection. File/memory stores keep the same names.
const KV_KEYS = {
  users: "passlink:tg:allow", // chatId -> JSON({id, addedAt, addedBy})
  groups: "passlink:tg:groups", // groupId -> JSON({id, addedAt, addedBy, welcome, rules, farewell})
  warns: "passlink:tg:warns", // `${groupId}:${userId}` -> JSON({id, count, reason})
};

export function isConfigured() {
  return Boolean(BOT_TOKEN);
}

export function getWebhookSecret() {
  return WEBHOOK_SECRET;
}

// --- Allowlist / settings store (namespaced: users | groups | warns) ---------

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
  const key = (coll) => KV_KEYS[coll];
  return {
    name: "upstash-kv",
    async list(coll) {
      const result = await kvCall(["HVALS", key(coll)]);
      if (!Array.isArray(result)) return [];
      return result
        .map((v) => {
          try { return JSON.parse(v); } catch { return null; }
        })
        .filter(Boolean);
    },
    async get(coll, id) {
      const v = await kvCall(["HGET", key(coll), id]);
      if (!v) return null;
      try { return JSON.parse(v); } catch { return null; }
    },
    async has(coll, id) {
      const v = await kvCall(["HGET", key(coll), id]);
      return Boolean(v);
    },
    async add(coll, entry) {
      await kvCall(["HSET", key(coll), entry.id, JSON.stringify(entry)]);
    },
    async remove(coll, id) {
      const r = await kvCall(["HDEL", key(coll), id]);
      return r > 0;
    },
  };
}

function fileStore(filePath) {
  let cache = null; // { users: Map, groups: Map, warns: Map }
  async function load() {
    if (cache) return cache;
    try {
      const data = JSON.parse(await fs.readFile(filePath, "utf8"));
      cache = {
        users: new Map(Object.entries(data.users || {})),
        groups: new Map(Object.entries(data.groups || {})),
        warns: new Map(Object.entries(data.warns || {})),
      };
    } catch (e) {
      if (e.code !== "ENOENT") console.warn("[passlink-tg] store read error:", e.message);
      cache = { users: new Map(), groups: new Map(), warns: new Map() };
    }
    return cache;
  }
  async function save() {
    const c = await load();
    const obj = {
      users: Object.fromEntries(c.users),
      groups: Object.fromEntries(c.groups),
      warns: Object.fromEntries(c.warns),
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
    await fs.writeFile(filePath, JSON.stringify(obj, null, 2));
  }
  return {
    name: `file(${filePath})`,
    async list(coll) {
      return Array.from((await load())[coll].values());
    },
    async get(coll, id) {
      return (await load())[coll].get(id) || null;
    },
    async has(coll, id) {
      return (await load())[coll].has(id);
    },
    async add(coll, entry) {
      (await load())[coll].set(entry.id, entry);
      await save();
    },
    async remove(coll, id) {
      const m = (await load())[coll];
      const had = m.delete(id);
      if (had) await save();
      return had;
    },
  };
}

function memoryStore() {
  const colls = { users: new Map(), groups: new Map(), warns: new Map() };
  return {
    name: "memory",
    async list(coll) { return Array.from(colls[coll].values()); },
    async get(coll, id) { return colls[coll].get(id) || null; },
    async has(coll, id) { return colls[coll].has(id); },
    async add(coll, entry) { colls[coll].set(entry.id, entry); },
    async remove(coll, id) { return colls[coll].delete(id); },
  };
}

function pickStore() {
  if (KV_URL && KV_TOKEN) return kvStore();
  if (process.env.TELEGRAM_DATA_FILE) return fileStore(process.env.TELEGRAM_DATA_FILE);
  if (process.env.VERCEL) return fileStore("/tmp/passlink-tg.json");
  return fileStore(path.resolve(process.cwd(), ".passlink-tg.json"));
}

const store = pickStore();

// Collection-bound helpers so call sites stay readable.
const users = {
  list: () => store.list("users"),
  get: (id) => store.get("users", String(id)),
  has: (id) => store.has("users", String(id)),
  add: (e) => store.add("users", e),
  remove: (id) => store.remove("users", String(id)),
};
const groups = {
  list: () => store.list("groups"),
  get: (id) => store.get("groups", String(id)),
  has: (id) => store.has("groups", String(id)),
  add: (e) => store.add("groups", e),
  remove: (id) => store.remove("groups", String(id)),
};
const warns = {
  get: (id) => store.get("warns", String(id)),
  add: (e) => store.add("warns", e),
  remove: (id) => store.remove("warns", String(id)),
};

async function updateGroup(id, patch) {
  const cur = (await groups.get(id)) || { id: String(id), addedAt: Date.now() };
  await groups.add({ ...cur, ...patch, id: String(id) });
}

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

async function sendMessage(chatId, text, { replyTo, keyboard } = {}) {
  const payload = { chat_id: chatId, text, disable_web_page_preview: false };
  if (replyTo) payload.reply_to_message_id = replyTo;
  if (keyboard) payload.reply_markup = keyboard;
  return tg("sendMessage", payload);
}

async function editMessageText(chatId, messageId, text) {
  return tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: false,
  });
}

async function deleteMessage(chatId, messageId) {
  return tg("deleteMessage", { chat_id: chatId, message_id: messageId });
}

let botUsernamePromise = null;
async function getBotUsername() {
  if (!botUsernamePromise) {
    botUsernamePromise = tg("getMe")
      .then((d) => d?.result?.username || null)
      .catch(() => null);
  }
  return botUsernamePromise;
}

export { tg };

// --- Authorization -----------------------------------------------------------

function isAdmin(id) {
  return ADMIN_IDS.has(String(id));
}

async function isAuthorized(id) {
  return isAdmin(id) || (await users.has(id));
}

async function isGroupApproved(chatId) {
  return ENV_GROUP_IDS.has(String(chatId)) || (await groups.has(chatId));
}

// A moderator is an env admin OR a Telegram admin/creator of that group.
async function isGroupModerator(chatId, userId) {
  if (isAdmin(userId)) return true;
  const r = await tg("getChatMember", { chat_id: chatId, user_id: userId });
  const status = r?.result?.status;
  return status === "creator" || status === "administrator";
}

// --- Link extraction ---------------------------------------------------------

function extractUrl(text) {
  if (!text) return null;
  const explicit = text.match(/https?:\/\/\S+/i);
  if (explicit) return explicit[0];
  // Bare domain like "bit.ly/abc" — normalizeUrl() in bypass adds the scheme.
  const bare = text.match(/\b[\w-]+(?:\.[\w-]+)+(?:\/\S*)?/);
  return bare ? bare[0] : null;
}

// --- Command parsing ---------------------------------------------------------

// Parse "/cmd", "/cmd@botname args" -> { cmd, mention, args }. null if not a command.
function parseCommand(text) {
  const m = text.match(/^\/([a-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), mention: m[2] || null, args: (m[3] || "").trim() };
}

// --- Display helpers ---------------------------------------------------------

function displayName(user) {
  if (!user) return "there";
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (name) return name;
  if (user.username) return `@${user.username}`;
  return String(user.id);
}

function fillTemplate(tpl, { user, chat, count }) {
  return tpl
    .replaceAll("{name}", displayName(user))
    .replaceAll("{first}", user?.first_name || displayName(user))
    .replaceAll("{username}", user?.username ? `@${user.username}` : displayName(user))
    .replaceAll("{group}", chat?.title || "the group")
    .replaceAll("{count}", count != null ? String(count) : "");
}

// --- Buttons (private-chat reply keyboard) -----------------------------------

const BTN = {
  whoami: "🆔 My chat ID",
  help: "❓ Help",
  list: "📋 List users",
  add: "➕ Add user",
  remove: "➖ Remove user",
  groups: "📢 Groups",
};
const BUTTON_LABELS = new Set(Object.values(BTN));

// Persistent keyboard shown under the text box; admins get the extra rows.
function keyboardFor(admin) {
  const rows = [[BTN.whoami, BTN.help]];
  if (admin) rows.push([BTN.list, BTN.groups], [BTN.add, BTN.remove]);
  return {
    keyboard: rows.map((row) => row.map((t) => ({ text: t }))),
    resize_keyboard: true,
    is_persistent: true,
  };
}

// Admin tapped "Add user"/"Remove user" and we're awaiting the chat ID.
// In-memory: fine for the single poll/Express process (not multi-instance).
const pendingAction = new Map(); // chatId -> "add" | "remove"

// --- Help text ---------------------------------------------------------------

const USER_HELP = [
  "🔓 PassLink Bot",
  "",
  "Send me a shortened or ad-gated link and I'll reply with the final destination.",
  "",
  "Use the buttons below 👇",
].join("\n");

function adminHelp() {
  return [
    USER_HELP,
    "",
    "Admin buttons:",
    "📋 List users · ➕ Add user · ➖ Remove user · 📢 Groups",
    "",
    "Group commands (typed): /groups, /addgroup <id>, /removegroup <id>",
  ].join("\n");
}

const GROUP_HELP = [
  "🔓 PassLink Bot",
  "",
  "Bypass a link:",
  "• just paste the link here — I'll resolve it automatically",
  "• or /bypass <link>  (alias /pl)",
  "• or reply to a message that has a link with /bypass",
  "",
  "Info: /whoami · /rules",
  "",
  "Moderator commands (group admins):",
  "/ban /unban /kick /mute [min] /unmute /warn [reason] /unwarn /warns",
  "/pin /unpin /del /setwelcome <text> /welcome /setrules <text>",
  "/approvegroup /revokegroup",
].join("\n");

const DEFAULT_WELCOME = "👋 Welcome {name} to {group}!\nSend a link with /bypass <link> to get the final destination.";

// --- Update handler ----------------------------------------------------------

export async function handleUpdate(update) {
  // Bot added to / removed from a chat.
  if (update?.my_chat_member) {
    await handleMyChatMember(update.my_chat_member);
    return;
  }

  const message = update?.message || update?.edited_message;
  if (!message) return;

  const chat = message.chat;
  const chatId = chat?.id;
  if (!chatId) return;

  // Membership change events arrive as service messages.
  if (Array.isArray(message.new_chat_members) && message.new_chat_members.length) {
    await handleNewMembers(message);
    return;
  }
  if (message.left_chat_member) {
    await handleLeftMember(message);
    return;
  }

  const text = message.text;
  if (typeof text !== "string") return;

  if (chat.type === "private") {
    await handlePrivate(message);
  } else if (chat.type === "group" || chat.type === "supergroup") {
    await handleGroup(message);
  }
}

// --- Private chat ------------------------------------------------------------

async function handlePrivate(message) {
  const chatId = message.chat.id;
  const fromId = message.from?.id ?? chatId;
  const trimmed = message.text.trim();
  const admin = isAdmin(fromId);

  // If an admin tapped Add/Remove, the next (non-button) message is the chat ID.
  if (admin && pendingAction.has(chatId) && !BUTTON_LABELS.has(trimmed)) {
    const action = pendingAction.get(chatId);
    pendingAction.delete(chatId);
    if (/^\/?cancel$/i.test(trimmed)) {
      await sendMessage(chatId, "Cancelled.", { keyboard: keyboardFor(true) });
    } else {
      await applyAddRemove(chatId, action, trimmed);
    }
    return;
  }

  // /whoami and /help/start (and their buttons) are available to everyone.
  if (/^\/whoami\b/i.test(trimmed) || trimmed === BTN.whoami) {
    await sendMessage(chatId, `Your chat ID is: ${chatId}`, { keyboard: keyboardFor(admin) });
    return;
  }
  if (/^\/(start|help)\b/i.test(trimmed) || trimmed === BTN.help) {
    await sendMessage(chatId, admin ? adminHelp() : USER_HELP, { keyboard: keyboardFor(admin) });
    return;
  }

  // Admin user management — via buttons or typed commands.
  if (trimmed === BTN.list || /^\/list\b/i.test(trimmed)) {
    if (!admin) return void (await sendMessage(chatId, "⛔ Admin only."));
    await listUsers(chatId);
    return;
  }
  if (trimmed === BTN.groups || /^\/groups\b/i.test(trimmed)) {
    if (!admin) return void (await sendMessage(chatId, "⛔ Admin only."));
    await listGroups(chatId);
    return;
  }
  if (trimmed === BTN.add || trimmed === BTN.remove) {
    if (!admin) return void (await sendMessage(chatId, "⛔ Admin only."));
    const action = trimmed === BTN.add ? "add" : "remove";
    pendingAction.set(chatId, action);
    await sendMessage(
      chatId,
      action === "add"
        ? "➕ Send the chat ID to authorize (or /cancel):"
        : "➖ Send the chat ID to revoke (or /cancel):",
    );
    return;
  }
  if (/^\/(add|remove)\b/i.test(trimmed)) {
    if (!admin) return void (await sendMessage(chatId, "⛔ Admin only."));
    await handleAdminCommand(chatId, trimmed);
    return;
  }
  if (/^\/(addgroup|removegroup)\b/i.test(trimmed)) {
    if (!admin) return void (await sendMessage(chatId, "⛔ Admin only."));
    await handleGroupCommand(chatId, trimmed);
    return;
  }

  // Everything else is treated as a bypass request — gated by authorization.
  if (!(await isAuthorized(fromId))) {
    await sendMessage(
      chatId,
      `⛔ Not authorized.\nYour chat ID is: ${chatId}\nAsk an admin to add you.`,
      { keyboard: keyboardFor(false) },
    );
    return;
  }

  const url = extractUrl(trimmed);
  if (!url) {
    await sendMessage(chatId, "Send me a link to bypass, or tap a button below.", {
      keyboard: keyboardFor(admin),
    });
    return;
  }
  await runBypass(chatId, url, message.message_id);
}

// --- Group chat --------------------------------------------------------------

async function handleGroup(message) {
  const chat = message.chat;
  const chatId = chat.id;
  const fromId = message.from?.id;

  // Never react to other bots (or our own echoed output) — prevents loops.
  if (message.from?.is_bot) return;

  const parsed = parseCommand(message.text.trim());

  // Plain (non-command) message: in an approved group, auto-bypass any link it
  // contains. Members can just paste a link — /bypass is optional. Non-link
  // chatter is ignored.
  if (!parsed) {
    if (!(await isGroupApproved(chatId))) return;
    const url = extractUrl(message.text);
    if (url) await runBypass(chatId, url, message.message_id);
    return;
  }

  // If the command is addressed to a specific bot, make sure it's us.
  if (parsed.mention) {
    const me = await getBotUsername();
    if (me && parsed.mention.toLowerCase() !== me.toLowerCase()) return;
  }

  const { cmd, args } = parsed;

  // Universally available, even before approval — lets admins find the group ID.
  if (cmd === "whoami") {
    await sendMessage(
      chatId,
      `Group: ${chat.title || "(untitled)"}\nGroup chat ID: ${chatId}\nYour user ID: ${fromId}`,
      { replyTo: message.message_id },
    );
    return;
  }
  if (cmd === "approvegroup") {
    if (!(await isGroupModerator(chatId, fromId))) {
      return void (await sendMessage(chatId, "⛔ Only a group admin can approve this group.", { replyTo: message.message_id }));
    }
    if (await isGroupApproved(chatId)) {
      return void (await sendMessage(chatId, "✅ This group is already approved.", { replyTo: message.message_id }));
    }
    await groups.add({ id: String(chatId), addedAt: Date.now(), addedBy: String(fromId) });
    await sendMessage(chatId, "✅ Group approved! Members can now use /bypass <link>.", { replyTo: message.message_id });
    return;
  }

  const approved = await isGroupApproved(chatId);

  // In unapproved groups, stay quiet except to tell admins how to approve.
  if (!approved) {
    if (cmd === "help" || cmd === "start" || cmd === "bypass" || cmd === "pl" || cmd === "p" || cmd === "passlink") {
      await sendMessage(
        chatId,
        "⛔ This group isn't approved for PassLink yet.\nA group admin can run /approvegroup here.",
        { replyTo: message.message_id },
      );
    }
    return;
  }

  // ---- Approved group ----
  switch (cmd) {
    case "help":
    case "start":
      await sendMessage(chatId, GROUP_HELP, { replyTo: message.message_id });
      return;
    case "rules":
      await showRules(chatId, message.message_id);
      return;
    case "bypass":
    case "pl":
    case "p":
    case "passlink": {
      const source = args || message.reply_to_message?.text || message.reply_to_message?.caption || "";
      const url = extractUrl(source);
      if (!url) {
        await sendMessage(chatId, "Usage: /bypass <link>  (or reply to a message that has a link)", { replyTo: message.message_id });
        return;
      }
      await runBypass(chatId, url, message.message_id);
      return;
    }
  }

  // ---- Moderation (group admins / env admins only) ----
  const MOD_CMDS = new Set([
    "ban", "unban", "kick", "mute", "unmute", "warn", "unwarn", "warns",
    "pin", "unpin", "del", "delete", "setwelcome", "welcome", "setrules", "revokegroup",
  ]);
  if (MOD_CMDS.has(cmd)) {
    if (!(await isGroupModerator(chatId, fromId))) {
      return void (await sendMessage(chatId, "⛔ Moderator only.", { replyTo: message.message_id }));
    }
    await handleModeration(cmd, args, message);
  }
}

// --- Moderation actions ------------------------------------------------------

const MUTE_PERMS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
};
const UNMUTE_PERMS = Object.fromEntries(Object.keys(MUTE_PERMS).map((k) => [k, true]));

// Resolve the target user from a reply, or a numeric user ID in the args.
function resolveTarget(message, args) {
  if (message.reply_to_message?.from) {
    const u = message.reply_to_message.from;
    return { id: u.id, name: displayName(u) };
  }
  const m = args.match(/-?\d+/);
  if (m) return { id: Number(m[0]), name: m[0] };
  return null;
}

// Strip a leading numeric user ID from args, leaving the reason text.
function reasonFrom(args) {
  return args.replace(/^-?\d+\s*/, "").trim();
}

async function handleModeration(cmd, args, message) {
  const chatId = message.chat.id;
  const replyTo = message.message_id;

  switch (cmd) {
    case "setwelcome": {
      if (!args) {
        return void (await sendMessage(chatId, "Usage: /setwelcome <text>\nPlaceholders: {name} {first} {username} {group} {count}", { replyTo }));
      }
      await updateGroup(chatId, { welcome: args });
      await sendMessage(chatId, "✅ Welcome message updated.", { replyTo });
      return;
    }
    case "welcome": {
      const g = await groups.get(chatId);
      await sendMessage(chatId, `Current welcome message:\n\n${g?.welcome || DEFAULT_WELCOME}`, { replyTo });
      return;
    }
    case "setrules": {
      if (!args) {
        return void (await sendMessage(chatId, "Usage: /setrules <text>", { replyTo }));
      }
      await updateGroup(chatId, { rules: args });
      await sendMessage(chatId, "✅ Rules updated.", { replyTo });
      return;
    }
    case "revokegroup": {
      await groups.remove(chatId);
      await sendMessage(chatId, "✅ Group approval revoked. /bypass is disabled here.", { replyTo });
      return;
    }
    case "pin": {
      if (!message.reply_to_message) {
        return void (await sendMessage(chatId, "Reply to the message you want to pin with /pin.", { replyTo }));
      }
      const r = await tg("pinChatMessage", { chat_id: chatId, message_id: message.reply_to_message.message_id });
      await sendMessage(chatId, r.ok ? "📌 Pinned." : `❌ Couldn't pin: ${r.description || "missing admin rights?"}`, { replyTo });
      return;
    }
    case "unpin": {
      const target = message.reply_to_message?.message_id;
      const r = target
        ? await tg("unpinChatMessage", { chat_id: chatId, message_id: target })
        : await tg("unpinAllChatMessages", { chat_id: chatId });
      await sendMessage(chatId, r.ok ? "📌 Unpinned." : `❌ Couldn't unpin: ${r.description || "missing admin rights?"}`, { replyTo });
      return;
    }
    case "del":
    case "delete": {
      if (!message.reply_to_message) {
        return void (await sendMessage(chatId, "Reply to the message you want to delete with /del.", { replyTo }));
      }
      const r = await deleteMessage(chatId, message.reply_to_message.message_id);
      // Also remove the command itself to keep the chat tidy.
      await deleteMessage(chatId, replyTo).catch(() => {});
      if (!r.ok) await sendMessage(chatId, `❌ Couldn't delete: ${r.description || "missing admin rights?"}`);
      return;
    }
  }

  // Commands below all act on a target user.
  const target = resolveTarget(message, args);
  if (!target) {
    await sendMessage(chatId, "Point at a user: reply to their message, or pass their numeric user ID.", { replyTo });
    return;
  }
  if (isAdmin(target.id) || (await isGroupModerator(chatId, target.id))) {
    await sendMessage(chatId, "⛔ That user is an admin — refusing.", { replyTo });
    return;
  }

  switch (cmd) {
    case "ban": {
      const r = await tg("banChatMember", { chat_id: chatId, user_id: target.id });
      await sendMessage(chatId, r.ok ? `🔨 Banned ${target.name}.` : `❌ ${r.description || "missing admin rights?"}`, { replyTo });
      return;
    }
    case "unban": {
      const r = await tg("unbanChatMember", { chat_id: chatId, user_id: target.id, only_if_banned: true });
      await sendMessage(chatId, r.ok ? `✅ Unbanned ${target.name}.` : `❌ ${r.description || "error"}`, { replyTo });
      return;
    }
    case "kick": {
      // Kick = ban then immediately unban so they can rejoin.
      const b = await tg("banChatMember", { chat_id: chatId, user_id: target.id });
      if (b.ok) await tg("unbanChatMember", { chat_id: chatId, user_id: target.id, only_if_banned: true });
      await sendMessage(chatId, b.ok ? `👢 Kicked ${target.name}.` : `❌ ${b.description || "missing admin rights?"}`, { replyTo });
      return;
    }
    case "mute": {
      const minutes = Number.parseInt(reasonFrom(args), 10);
      const payload = { chat_id: chatId, user_id: target.id, permissions: MUTE_PERMS };
      if (Number.isFinite(minutes) && minutes > 0) {
        payload.until_date = Math.floor(Date.now() / 1000) + minutes * 60;
      }
      const r = await tg("restrictChatMember", payload);
      const dur = Number.isFinite(minutes) && minutes > 0 ? ` for ${minutes} min` : "";
      await sendMessage(chatId, r.ok ? `🔇 Muted ${target.name}${dur}.` : `❌ ${r.description || "missing admin rights?"}`, { replyTo });
      return;
    }
    case "unmute": {
      const r = await tg("restrictChatMember", { chat_id: chatId, user_id: target.id, permissions: UNMUTE_PERMS });
      await sendMessage(chatId, r.ok ? `🔊 Unmuted ${target.name}.` : `❌ ${r.description || "error"}`, { replyTo });
      return;
    }
    case "warn": {
      const reason = reasonFrom(args);
      const key = `${chatId}:${target.id}`;
      const cur = (await warns.get(key))?.count || 0;
      const count = cur + 1;
      if (count >= WARN_LIMIT) {
        await warns.remove(key);
        const b = await tg("banChatMember", { chat_id: chatId, user_id: target.id });
        await sendMessage(
          chatId,
          b.ok
            ? `⚠️ ${target.name} reached ${WARN_LIMIT} warnings — banned.`
            : `⚠️ ${target.name} hit the warn limit, but ban failed: ${b.description || "missing admin rights?"}`,
          { replyTo },
        );
      } else {
        await warns.add({ id: key, count, reason });
        await sendMessage(
          chatId,
          `⚠️ Warned ${target.name} (${count}/${WARN_LIMIT})${reason ? `: ${reason}` : ""}.`,
          { replyTo },
        );
      }
      return;
    }
    case "unwarn": {
      const key = `${chatId}:${target.id}`;
      const cur = (await warns.get(key))?.count || 0;
      if (cur <= 1) {
        await warns.remove(key);
        await sendMessage(chatId, `✅ Cleared warnings for ${target.name}.`, { replyTo });
      } else {
        await warns.add({ id: key, count: cur - 1 });
        await sendMessage(chatId, `✅ ${target.name} now has ${cur - 1}/${WARN_LIMIT} warnings.`, { replyTo });
      }
      return;
    }
    case "warns": {
      const cur = (await warns.get(`${chatId}:${target.id}`))?.count || 0;
      await sendMessage(chatId, `${target.name} has ${cur}/${WARN_LIMIT} warnings.`, { replyTo });
      return;
    }
  }
}

async function showRules(chatId, replyTo) {
  const g = await groups.get(chatId);
  await sendMessage(chatId, g?.rules ? `📜 Group rules:\n\n${g.rules}` : "No rules set. A moderator can add them with /setrules <text>.", { replyTo });
}

// --- Membership events -------------------------------------------------------

async function handleMyChatMember(upd) {
  const chat = upd.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
  const status = upd.new_chat_member?.status;
  if (status !== "member" && status !== "administrator") return; // ignore leaves/kicks

  if (await isGroupApproved(chat.id)) {
    await sendMessage(chat.id, "✅ PassLink is active here. Members can use /bypass <link>.");
  } else {
    await sendMessage(
      chat.id,
      [
        "👋 Thanks for adding PassLink!",
        `Group chat ID: ${chat.id}`,
        "A group admin must approve me — send /approvegroup here.",
        "Tip: make me an admin so I can moderate (delete, ban, mute, pin).",
      ].join("\n"),
    );
  }
}

async function handleNewMembers(message) {
  const chat = message.chat;
  if (!(await isGroupApproved(chat.id))) return;
  const me = await getBotUsername();
  const g = await groups.get(chat.id);
  const template = g?.welcome || DEFAULT_WELCOME;

  for (const member of message.new_chat_members) {
    if (member.is_bot && me && member.username && member.username.toLowerCase() === me.toLowerCase()) {
      continue; // don't greet ourselves
    }
    const text = fillTemplate(template, { user: member, chat });
    await sendMessage(chat.id, text);
  }
}

async function handleLeftMember(message) {
  const chat = message.chat;
  if (!(await isGroupApproved(chat.id))) return;
  const g = await groups.get(chat.id);
  if (!g?.farewell) return; // farewell is opt-in (set via /setfarewell — off by default)
  await sendMessage(chat.id, fillTemplate(g.farewell, { user: message.left_chat_member, chat }));
}

// --- Shared bypass runner ----------------------------------------------------

async function runBypass(chatId, url, userMessageId) {
  const countdownText = (n) => `⏳ Generating your link…\n\n${n}`;
  const sent = await sendMessage(
    chatId,
    COUNTDOWN_SECONDS > 0 ? countdownText(COUNTDOWN_SECONDS) : "⏳ Generating your link…",
  );
  const progressId = sent?.result?.message_id;

  // Resolve in the background while we count down — but the link is never shown
  // until the countdown has fully elapsed.
  const settled = bypass(url).then(
    (result) => ({ ok: true, result }),
    (err) => ({ ok: false, err }),
  );
  settled.catch(() => {}); // pre-handle so a fast failure can't go unhandled

  // The initial message already shows COUNTDOWN_SECONDS, so the first tick is a
  // sleep only; subsequent ticks edit the number down.
  for (let n = COUNTDOWN_SECONDS; n >= 1; n--) {
    if (n < COUNTDOWN_SECONDS && progressId) {
      await editMessageText(chatId, progressId, countdownText(n)).catch(() => {});
    }
    await sleep(1000);
  }

  // Countdown done. If the bypass is still running, show a finalizing state
  // (still no link) until it settles.
  let pending = true;
  settled.finally(() => { pending = false; });
  await sleep(50);
  if (pending && progressId) {
    await editMessageText(chatId, progressId, "✅ Done! Finalizing…").catch(() => {});
  }

  const outcome = await settled;
  const finalText = outcome.ok
    ? `✅ Destination:\n${outcome.result.finalUrl}\n\n(${outcome.result.hops} hop${outcome.result.hops === 1 ? "" : "s"}, ${outcome.result.elapsedMs}ms)`
    : `❌ Failed: ${outcome.err?.message || String(outcome.err)}`;

  // Remove the countdown message and deliver the result as a reply to the
  // user's original link message.
  if (progressId) await deleteMessage(chatId, progressId).catch(() => {});
  await sendMessage(chatId, finalText, { replyTo: userMessageId });
}

// --- User management (private-chat admin) ------------------------------------

async function listUsers(chatId) {
  const list = await users.list();
  const adminList = [...ADMIN_IDS].map((id) => `• ${id} (admin, env)`);
  const userList = list
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))
    .map((u) => `• ${u.id}`);
  const lines = [...adminList, ...userList];
  await sendMessage(
    chatId,
    lines.length ? `Authorized:\n${lines.join("\n")}` : "No users authorized yet.",
    { keyboard: keyboardFor(true) },
  );
}

async function applyAddRemove(chatId, action, idText) {
  const kb = { keyboard: keyboardFor(true) };
  const id = String(idText).trim();
  if (!/^-?\d+$/.test(id)) {
    await sendMessage(chatId, "That's not a valid chat ID. Send digits only, e.g. 123456789.", kb);
    return;
  }
  if (action === "add") {
    if (isAdmin(id)) {
      await sendMessage(chatId, `${id} is already an admin.`, kb);
      return;
    }
    await users.add({ id, addedAt: Date.now(), addedBy: String(chatId) });
    await sendMessage(chatId, `✅ Added ${id}.`, kb);
    return;
  }
  // remove
  if (isAdmin(id)) {
    await sendMessage(chatId, "Cannot remove an admin (set via env var).", kb);
    return;
  }
  const had = await users.remove(id);
  await sendMessage(chatId, had ? `✅ Removed ${id}.` : `${id} was not in the list.`, kb);
}

// Typed "/add 123" / "/remove 123" (buttons use applyAddRemove directly).
async function handleAdminCommand(chatId, text) {
  const [cmd, arg] = text.split(/\s+/);
  const action = /^\/add$/i.test(cmd) ? "add" : "remove";
  if (!arg) {
    await sendMessage(chatId, `Usage: ${cmd} <chat_id>\nExample: ${cmd} 123456789`);
    return;
  }
  await applyAddRemove(chatId, action, arg);
}

// --- Group management (private-chat admin) -----------------------------------

async function listGroups(chatId) {
  const list = await groups.list();
  const envList = [...ENV_GROUP_IDS].map((id) => `• ${id} (env)`);
  const dynList = list
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))
    .map((g) => `• ${g.id}${g.welcome ? " (custom welcome)" : ""}`);
  const lines = [...envList, ...dynList];
  await sendMessage(
    chatId,
    lines.length
      ? `Approved groups:\n${lines.join("\n")}`
      : "No groups approved yet.\nAdd the bot to a group and run /approvegroup there.",
    { keyboard: keyboardFor(true) },
  );
}

// Typed "/addgroup -100123" / "/removegroup -100123".
async function handleGroupCommand(chatId, text) {
  const [cmd, arg] = text.split(/\s+/);
  const action = /^\/addgroup$/i.test(cmd) ? "add" : "remove";
  if (!arg || !/^-?\d+$/.test(arg)) {
    await sendMessage(chatId, `Usage: ${cmd} <group_id>\nTip: run /whoami inside the group to get its ID.`);
    return;
  }
  if (action === "add") {
    await groups.add({ id: String(arg), addedAt: Date.now(), addedBy: String(chatId) });
    await sendMessage(chatId, `✅ Group ${arg} approved.`, { keyboard: keyboardFor(true) });
  } else {
    const had = await groups.remove(arg);
    await sendMessage(chatId, had ? `✅ Group ${arg} removed.` : `${arg} was not approved.`, { keyboard: keyboardFor(true) });
  }
}
