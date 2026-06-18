// Minimal, dependency-free .env loader.
// On Vercel, env vars come from the dashboard so there is no .env file (and that's fine).
import fs from "node:fs";
import path from "node:path";

let loaded = false;

export function loadEnv() {
  if (loaded) return;
  loaded = true;
  try {
    const file = path.resolve(process.cwd(), ".env");
    const txt = fs.readFileSync(file, "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* no .env present — rely on real environment variables */
  }
}
