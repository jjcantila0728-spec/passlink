import { loadEnv } from "../lib/env.js";
import { handleUpdate, isConfigured, getWebhookSecret } from "../lib/telegram.js";

loadEnv();

export const config = { maxDuration: 30 };

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.length) {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return await new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    return res.end();
  }

  if (!isConfigured()) {
    res.statusCode = 500;
    return res.end("TELEGRAM_BOT_TOKEN not configured");
  }

  // Verify Telegram's secret token (set when registering the webhook).
  const secret = getWebhookSecret();
  if (secret) {
    const got = req.headers["x-telegram-bot-api-secret-token"];
    if (got !== secret) {
      res.statusCode = 401;
      return res.end("unauthorized");
    }
  }

  const update = await readJsonBody(req);

  // Process the update BEFORE responding. On serverless the function can be
  // frozen the instant the response is flushed, which would kill the outbound
  // sendMessage if we replied first. Telegram allows ~60s before it retries and
  // our slowest path (countdown + bypass) stays well under maxDuration, so
  // awaiting here is safe.
  if (update) {
    try {
      await handleUpdate(update);
    } catch (err) {
      console.error("[passlink-tg] handleUpdate error:", err);
    }
  }

  res.statusCode = 200;
  res.end("ok");
}
