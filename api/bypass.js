import { bypass } from "../lib/bypass.js";
import { isValidCode } from "../lib/auth.js";

export const config = { maxDuration: 30 };

function getAccessCode(req) {
  return (
    req.headers?.["x-access-code"] ||
    req.headers?.["X-Access-Code"] ||
    req.query?.code ||
    null
  );
}

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
  const accessCode = getAccessCode(req);
  if (!(await isValidCode(accessCode))) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: "Invalid or expired access code" }));
  }

  let url;
  if (req.method === "POST") {
    const body = await readJsonBody(req);
    url = body && body.url;
  } else if (req.method === "GET") {
    url = req.query?.url;
  } else {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    return res.end();
  }

  if (!url || typeof url !== "string") {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: "Missing 'url'" }));
  }

  try {
    const result = await bypass(url);
    if (req.method === "GET" && req.query?.redirect === "1") {
      res.statusCode = 302;
      res.setHeader("Location", result.finalUrl);
      return res.end();
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, ...result }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  }
}
