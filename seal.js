// seal.js — AES-256-GCM sealing with SESSION_KEY. A sealed value can only be read, and only be
// made, by this connector: tampering or another key makes it unreadable. Used for the token
// Claude / ChatGPT holds, the sign-in state that travels through AJEMS, the codes we hand out
// and the registered client ids — so nothing has to be stored.

import crypto from "node:crypto";
import { config } from "./config.js";

const key = () => {
  if (!/^[0-9a-f]{64}$/i.test(config.sessionKey)) throw new Error("SESSION_KEY is not set");
  return Buffer.from(config.sessionKey, "hex");
};

/** Seal an object for one purpose (`kind`): a value sealed as one kind never opens as another. */
export function seal(kind, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(`ajems-mcp:${kind}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

/** The object, or null when it is not ours, was changed, or is of another kind. */
export function unseal(kind, text) {
  try {
    const [iv, tag, body] = String(text || "").split(".").map((p) => Buffer.from(p, "base64url"));
    if (!iv || iv.length !== 12 || !tag || tag.length !== 16 || !body) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAAD(Buffer.from(`ajems-mcp:${kind}`));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
}

export const sha256 = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

/** PKCE S256: base64url(sha256(verifier)). */
export const challengeOf = (verifier) => crypto.createHash("sha256").update(verifier).digest("base64url");

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
