import { storage } from "./storage.js";

export const ADMIN_CODE = process.env.PASSLINK_ADMIN_CODE || "@JJ07ca14";
const USER_CODE_DAYS = 30;

export function isAdminCode(code) {
  if (!code || typeof code !== "string") return false;
  return code === ADMIN_CODE;
}

export async function isValidCode(code) {
  if (!code || typeof code !== "string") return false;
  if (isAdminCode(code)) return true;
  const entry = await storage.get(code);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) return false;
  return true;
}

export async function classify(code) {
  if (isAdminCode(code)) return { ok: true, role: "admin" };
  const entry = await storage.get(code);
  if (!entry) return { ok: false, error: "Invalid code" };
  if (entry.expiresAt < Date.now()) return { ok: false, error: "Code expired" };
  return { ok: true, role: "user", code: entry.code, expiresAt: entry.expiresAt };
}

function randomDigits(n) {
  let out = "";
  for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 10);
  return out;
}

export async function generateCodes(count = 1, days = USER_CODE_DAYS) {
  const n = Math.max(1, Math.min(50, Number(count) || 1));
  const ttlMs = Math.max(1, Math.min(365, Number(days) || USER_CODE_DAYS)) * 24 * 60 * 60 * 1000;
  const created = [];
  for (let i = 0; i < n; i++) {
    // Avoid collisions with existing codes.
    let code;
    for (let attempt = 0; attempt < 5; attempt++) {
      code = randomDigits(6);
      const existing = await storage.get(code);
      if (!existing) break;
      code = null;
    }
    if (!code) continue;
    const entry = {
      code,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
    await storage.put(entry);
    created.push(entry);
  }
  return created;
}

export async function listCodes() {
  const all = await storage.list();
  return all.map((e) => ({
    ...e,
    expired: e.expiresAt < Date.now(),
  }));
}

export async function revokeCode(code) {
  return await storage.del(code);
}
