import { createCipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { config } from "./config.ts";
import type { BaileysFiles } from "./convert.ts";

export const BUNDLE_VERSION = 1;

export function newSessionId(): string {
  return `${config.sessionPrefix}~${randomBytes(32).toString("base64url")}`;
}

// The server only ever stores this hash, never the session ID itself.
export function lookupKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function bundleKey(sessionId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", sessionId, "pair-server/v1", "bundle", 32));
}

// Same output as Baileys' BufferJSON.replacer, so files can be written as is.
function replacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && (value as { type?: string }).type === "Buffer") {
    return { type: "Buffer", data: Buffer.from((value as { data: number[] }).data).toString("base64") };
  }
  return value;
}

// gzip + AES-256-GCM: nonce (12) | ciphertext | tag (16).
export function sealBundle(sessionId: string, files: BaileysFiles): Buffer {
  const json = JSON.stringify({ v: BUNDLE_VERSION, files }, replacer);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", bundleKey(sessionId), nonce);
  const body = Buffer.concat([cipher.update(gzipSync(json)), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}
