/**
 * Foran Delivery MCP Server
 * Copyright (c) 2026 Foran Private Limited. MIT License.
 *
 * Stateless, encrypted session keys. After login the customer's Foran API
 * token is sealed with AES-256-GCM using FORAN_MCP_SECRET and handed to the
 * AI client as an opaque `session_key`. The server keeps no database, so it
 * survives restarts and scales horizontally. The raw token is never shown.
 */
import crypto from "node:crypto";

const DAYS = Number(process.env.FORAN_SESSION_DAYS || 7);

function key(): Buffer {
  const secret = process.env.FORAN_MCP_SECRET;
  if (!secret || secret.length < 32) {
    // Local stdio use: a per-process random key is fine (sessions end with the process).
    return ephemeral;
  }
  return crypto.createHash("sha256").update(secret).digest();
}
const ephemeral = crypto.randomBytes(32);

export interface Session {
  token: string;
  name?: string;
  exp: number;
}

export function seal(token: string, name?: string): string {
  const payload: Session = { token, name, exp: Date.now() + DAYS * 86_400_000 };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()]);
  return "fs1." + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64url");
}

export function open(sessionKey: string | undefined): Session {
  if (!sessionKey) throw new Error("This needs a logged-in customer. Call foran_login first and pass the session_key it returns.");
  try {
    if (!sessionKey.startsWith("fs1.")) throw new Error("bad prefix");
    const raw = Buffer.from(sessionKey.slice(4), "base64url");
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), enc = raw.subarray(28);
    const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
    d.setAuthTag(tag);
    const s = JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString("utf8")) as Session;
    if (Date.now() > s.exp) throw new Error("expired");
    return s;
  } catch {
    throw new Error("Session expired or invalid. Please call foran_login again.");
  }
}

/** Pakistani mobile numbers → +92XXXXXXXXXX (the format Foran stores). */
export function normalizePhone(input: string): string[] {
  const digits = input.replace(/[^\d+]/g, "");
  let local = digits.replace(/^\+/, "");
  if (local.startsWith("0092")) local = local.slice(4);
  else if (local.startsWith("92")) local = local.slice(2);
  else if (local.startsWith("0")) local = local.slice(1);
  const out = [`+92${local}`, `0${local}`];
  if (digits.startsWith("+") && !digits.startsWith("+92")) out.unshift(digits);
  return [...new Set(out)];
}
