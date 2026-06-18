import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bypass } from "./lib/bypass.js";
import {
  classify,
  isAdminCode,
  isValidCode,
  listCodes,
  generateCodes,
  revokeCode,
} from "./lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function getCode(req) {
  return (
    req.get("x-access-code") ||
    req.query.code ||
    (req.body && req.body.code) ||
    null
  );
}

async function requireValidCode(req, res, next) {
  if (await isValidCode(getCode(req))) return next();
  res.status(401).json({ ok: false, error: "Invalid or expired access code" });
}

function requireAdmin(req, res, next) {
  if (isAdminCode(getCode(req))) return next();
  res.status(403).json({ ok: false, error: "Admin access required" });
}

// --- Access code endpoints ---

app.post("/api/auth", async (req, res) => {
  const code = (req.body && req.body.code) || "";
  const result = await classify(code);
  if (!result.ok) return res.status(401).json(result);
  res.json(result);
});

app.get("/api/codes", requireAdmin, async (_req, res) => {
  const codes = await listCodes();
  res.json({ ok: true, codes });
});

app.post("/api/codes", requireAdmin, async (req, res) => {
  const { count, days } = req.body || {};
  const created = await generateCodes(count, days);
  res.json({ ok: true, created });
});

app.delete("/api/codes", requireAdmin, async (req, res) => {
  const code = (req.body && req.body.code) || req.query.code;
  if (!code) return res.status(400).json({ ok: false, error: "Missing 'code'" });
  const ok = await revokeCode(code);
  res.json({ ok });
});

// --- Bypass endpoints (gated) ---

app.post("/api/bypass", requireValidCode, async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ ok: false, error: "Missing 'url' in body" });
  }
  try {
    const result = await bypass(url);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.get("/api/bypass", requireValidCode, async (req, res) => {
  const url = req.query.url;
  const redirect = req.query.redirect === "1";
  if (!url || typeof url !== "string") {
    return res.status(400).json({ ok: false, error: "Missing 'url' query parameter" });
  }
  try {
    const result = await bypass(url);
    if (redirect) return res.redirect(302, result.finalUrl);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.get("/api/bypass-stream", requireValidCode, async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ ok: false, error: "Missing 'url' query parameter" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => res.write(`: ping\n\n`), 15000);

  try {
    const result = await bypass(url, { onNote: (note) => send("note", { note }) });
    send("done", { ok: true, ...result });
  } catch (err) {
    send("error", { ok: false, error: err.message || String(err) });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`PassLink running at http://localhost:${PORT}`);
});
