import { rm } from "node:fs/promises";
import NodeCache from "@cacheable/node-cache";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type CacheStore,
  type WAMessageContent,
  type WAMessageKey,
} from "baileys";
import pino from "pino";
import { restoreSession } from "../restore/restore-session.node.ts";

const AUTH_DIR = process.env.AUTH_DIR || "auth";
const SESSION_ID = process.env.SESSION_ID || "";
const PAIR_SERVER = process.env.PAIR_SERVER || "http://localhost:3000";

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

// Lives outside the socket so retry counts survive reconnects.
const msgRetryCounterCache = new NodeCache() as CacheStore;

// Messages we sent, so WhatsApp can ask for a resend when a phone could not decrypt one.
const sentMessages = new Map<string, WAMessageContent>();

let reconnectAttempt = 0;

function remember(id: string, content: WAMessageContent): void {
  sentMessages.set(id, content);
  if (sentMessages.size > 500) sentMessages.delete(sentMessages.keys().next().value!);
}

async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
  return key.id ? sentMessages.get(key.id) : undefined;
}

async function connect(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    msgRetryCounterCache,
    getMessage,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("✕ Baileys asked for a QR code: the session is missing or invalid. Pair again on the pair server.");
      process.exit(1);
    }

    if (connection === "open") {
      reconnectAttempt = 0;
      console.log(`✓ Connected as ${sock.user?.id}`);
      console.log('  Send "!ping" from any chat, including "Message yourself".');
      return;
    }

    if (connection !== "close") return;
    const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;

    if (code === DisconnectReason.loggedOut) {
      console.log("✕ Logged out from the phone. Deleting the auth folder; pair again for a new session ID.");
      await rm(AUTH_DIR, { recursive: true, force: true });
      process.exit(1);
    }
    if (code === DisconnectReason.connectionReplaced) {
      console.log("✕ Another client opened this session. Run only one bot per session ID.");
      process.exit(1);
    }

    // 515 (restart required) right after login is normal: reconnect at once.
    const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(1000 * 2 ** reconnectAttempt++, 30_000);
    console.log(`… Connection closed (${code ?? "unknown"}), reconnecting in ${delay / 1000}s`);
    setTimeout(() => void connect(), delay);
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const message of messages) {
      const text = message.message?.conversation || message.message?.extendedTextMessage?.text || "";
      if (text.trim().toLowerCase() !== "!ping" || !message.key.remoteJid) continue;

      const started = Date.now();
      const sent = await sock.sendMessage(
        message.key.remoteJid,
        { text: `pong 🏓\nBaileys, restored from a pair-server session ID.` },
        { quoted: message },
      );
      if (sent?.key.id && sent.message) remember(sent.key.id, sent.message);
      console.log(`→ pong to ${message.key.remoteJid} in ${Date.now() - started} ms`);
    }
  });
}

async function main(): Promise<void> {
  if (SESSION_ID) {
    const started = performance.now();
    const result = await restoreSession({ sessionId: SESSION_ID, server: PAIR_SERVER, dir: AUTH_DIR });
    console.log(
      result.restored
        ? `✓ Restored ${result.files} files from ${PAIR_SERVER} in ${Math.round(performance.now() - started)} ms`
        : `✓ Using the existing ${AUTH_DIR}/ folder`,
    );
  } else {
    console.log(`… No SESSION_ID set, using ${AUTH_DIR}/ as it is`);
  }

  await connect();
}

main().catch((error) => {
  console.error("✕", error instanceof Error ? error.message : error);
  process.exit(1);
});
