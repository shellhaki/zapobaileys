// pair-server session restore for Baileys (Node, CommonJS). Copy this file into your bot.
const { createDecipheriv, createHash, hkdfSync } = require("node:crypto");
const { existsSync } = require("node:fs");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");

const TIMEOUT_MS = 15_000;
const ATTEMPTS = 3;
const PARALLEL_WRITES = 64;

async function download(server, sessionId) {
  const lookup = createHash("sha256").update(sessionId).digest("hex");
  const url = `${server.replace(/\/+$/, "")}/api/session/${lookup}`;

  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((error) => error);
    if (response instanceof Response && response.status === 404) throw new Error("Unknown or expired session ID.");
    if (response instanceof Response && response.ok) return Buffer.from(await response.arrayBuffer());
    if (attempt === ATTEMPTS) throw response instanceof Error ? response : new Error(`Pair server answered ${response.status}.`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
}

function decrypt(sessionId, sealed) {
  const key = Buffer.from(hkdfSync("sha256", sessionId, "pair-server/v1", "bundle", 32));
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(-16));

  let json;
  try {
    json = gunzipSync(Buffer.concat([decipher.update(sealed.subarray(12, -16)), decipher.final()])).toString("utf8");
  } catch {
    throw new Error("Could not decrypt the session. Check that the session ID is complete.");
  }

  const bundle = JSON.parse(json);
  if (bundle.v !== 1) throw new Error(`Unsupported session format v${bundle.v}. Get the latest restore file.`);
  return bundle.files;
}

async function loadFiles(sessionId, server) {
  const id = sessionId?.trim();
  if (!id) throw new Error("sessionId is empty.");
  return decrypt(id, await download(server, id));
}

// Same file names as Baileys' useMultiFileAuthState.
function fileName(name) {
  return `${name.replace(/\//g, "__").replace(/:/g, "-")}.json`;
}

// Writes the session as Baileys multi-file auth state. Does nothing if creds.json exists.
async function restoreSession({ sessionId, server, dir = "auth", force = false }) {
  const folder = path.resolve(dir);
  if (!force && existsSync(path.join(folder, "creds.json"))) return { restored: false, dir: folder, files: 0 };

  const { creds, ...keys } = await loadFiles(sessionId, server);
  const entries = Object.entries(keys);
  await mkdir(folder, { recursive: true });

  let next = 0;
  const writer = async () => {
    while (next < entries.length) {
      const [name, value] = entries[next++];
      await writeFile(path.join(folder, fileName(name)), JSON.stringify(value));
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_WRITES }, writer));

  // creds.json last, so a half-written folder never looks like a session.
  await writeFile(path.join(folder, "creds.json"), JSON.stringify(creds));
  return { restored: true, dir: folder, files: entries.length + 1 };
}

// Returns the session for your own auth store (Mongo, Redis, ...), with real Buffers.
async function fetchSession({ sessionId, server }) {
  const files = await loadFiles(sessionId, server);
  const revived = JSON.parse(JSON.stringify(files), (_key, value) =>
    value?.type === "Buffer" && typeof value.data === "string" ? Buffer.from(value.data, "base64") : value,
  );
  const { creds, ...keys } = revived;
  return { creds, keys };
}

module.exports = { restoreSession, fetchSession };
