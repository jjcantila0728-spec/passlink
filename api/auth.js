import { classify } from "../lib/auth.js";

export const config = { maxDuration: 10 };

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
  res.setHeader("Content-Type", "application/json");
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    return res.end();
  }
  const body = (await readJsonBody(req)) || {};
  const code = body.code;
  if (!code || typeof code !== "string") {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: "Missing 'code'" }));
  }
  const result = await classify(code);
  if (!result.ok) {
    res.statusCode = 401;
    return res.end(JSON.stringify(result));
  }
  res.end(JSON.stringify(result));
}
