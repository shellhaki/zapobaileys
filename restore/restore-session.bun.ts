// pair-server session restore for Baileys (Bun). Copy this file into your bot.
import path from "node:path";

export interface RestoreOptions {
  sessionId: string;
  server: string;
  dir?: string;
  force?: boolean;
}

export interface SessionData {
  creds: Record<string, unknown>;
  keys: Record<string, unknown>;
}

const TIMEOUT_MS = 15_000;
const ATTEMPTS = 3;
const PARALLEL_WRITES = 64;
const encoder = new TextEncoder();

async function download(server: string, sessionId: string): Promise<Uint8Array<ArrayBuffer>> {
  const lookup = new Bun.CryptoHasher("sha256").update(sessionId).digest("hex");
  const url = `${server.replace(/\/+$/, "")}/api/session/${lookup}`;

  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((error) => error as Error);
    if (response instanceof Response && response.status === 404) throw new Error("Unknown or expired session ID.");
    if (response instanceof Response && response.ok) return new Uint8Array(await response.arrayBuffer());
    if (attempt === ATTEMPTS) throw response instanceof Error ? response : new Error(`Pair server answered ${response.status}.`);
    await Bun.sleep(attempt * 1000);
  }
}

async function decrypt(sessionId: string, sealed: Uint8Array<ArrayBuffer>): Promise<Record<string, unknown>> {
  const secret = await crypto.subtle.importKey("raw", encoder.encode(sessionId), "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("pair-server/v1"), info: encoder.encode("bundle") },
    secret,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  let json: string;
  try {
    const zipped = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.subarray(0, 12) }, key, sealed.subarray(12));
    json = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(zipped)));
  } catch {
    throw new Error("Could not decrypt the session. Check that the session ID is complete.");
  }

  const bundle = JSON.parse(json) as { v: number; files: Record<string, unknown> };
  if (bundle.v !== 1) throw new Error(`Unsupported session format v${bundle.v}. Get the latest restore file.`);
  return bundle.files;
}

async function loadFiles(sessionId: string, server: string): Promise<Record<string, unknown>> {
  const id = sessionId?.trim();
  if (!id) throw new Error("sessionId is empty.");
  return decrypt(id, await download(server, id));
}

// Same file names as Baileys' useMultiFileAuthState.
function fileName(name: string): string {
  return `${name.replace(/\//g, "__").replace(/:/g, "-")}.json`;
}

// Writes the session as Baileys multi-file auth state. Does nothing if creds.json exists.
export async function restoreSession({ sessionId, server, dir = "auth", force = false }: RestoreOptions) {
  const folder = path.resolve(dir);
  if (!force && (await Bun.file(path.join(folder, "creds.json")).exists())) return { restored: false, dir: folder, files: 0 };

  const { creds, ...keys } = await loadFiles(sessionId, server);
  const entries = Object.entries(keys);

  let next = 0;
  const writer = async () => {
    while (next < entries.length) {
      const [name, value] = entries[next++]!;
      await Bun.write(path.join(folder, fileName(name)), JSON.stringify(value));
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_WRITES }, writer));

  // creds.json last, so a half-written folder never looks like a session.
  await Bun.write(path.join(folder, "creds.json"), JSON.stringify(creds));
  return { restored: true, dir: folder, files: entries.length + 1 };
}

// Returns the session for your own auth store (Mongo, Redis, ...), with real Buffers.
export async function fetchSession({ sessionId, server }: Pick<RestoreOptions, "sessionId" | "server">): Promise<SessionData> {
  const files = await loadFiles(sessionId, server);
  const revived = JSON.parse(JSON.stringify(files), (_key, value) =>
    value?.type === "Buffer" && typeof value.data === "string" ? Buffer.from(value.data, "base64") : value,
  );
  const { creds, ...keys } = revived;
  return { creds, keys };
}
