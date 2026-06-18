import { isAdminCode, listCodes, generateCodes, revokeCode } from "../lib/auth.js";

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

function getAccessCode(req) {
  return (
    req.headers?.["x-access-code"] ||
    req.headers?.["X-Access-Code"] ||
    null
  );
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  const code = getAccessCode(req);
  if (!isAdminCode(code)) {
    res.statusCode = 403;
    return res.end(JSON.stringify({ ok: false, error: "Admin access required" }));
  }

  try {
    if (req.method === "GET") {
      const codes = await listCodes();
      return res.end(JSON.stringify({ ok: true, codes }));
    }
    if (req.method === "POST") {
      const body = (await readJsonBody(req)) || {};
      const created = await generateCodes(body.count, body.days);
      return res.end(JSON.stringify({ ok: true, created }));
    }
    if (req.method === "DELETE") {
      const body = (await readJsonBody(req)) || {};
      const target = body.code || req.query?.code;
      if (!target) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "Missing 'code'" }));
      }
      const ok = await revokeCode(target);
      return res.end(JSON.stringify({ ok }));
    }
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST, DELETE");
    res.end();
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  }
}
