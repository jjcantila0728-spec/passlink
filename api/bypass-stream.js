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

export default async function handler(req, res) {
  const accessCode = getAccessCode(req);
  if (!(await isValidCode(accessCode))) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: "Invalid or expired access code" }));
  }

  const url = req.query?.url;
  if (!url || typeof url !== "string") {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: "Missing 'url'" }));
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const heartbeat = setInterval(() => res.write(`: ping\n\n`), 15000);

  try {
    const result = await bypass(url, { onNote: (note) => send("note", { note }) });
    send("done", { ok: true, ...result });
  } catch (err) {
    send("error", { ok: false, error: err?.message || String(err) });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}
