import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import QRCode from "qrcode";
import { createStore, WaClient, type Logger } from "zapo-js";
import { createSqliteStore } from "@zapo-js/store-sqlite";
import { lookupKey, newSessionId, sealBundle } from "./bundle.ts";
import { config } from "./config.ts";
import { zapoToBaileys } from "./convert.ts";
import { saveSession } from "./store.ts";

export type PairEvent =
  | { type: "qr"; qr: string; svg: string }
  | { type: "code"; code: string }
  | { type: "scanned" }
  | { type: "success"; sessionId: string; phone: string }
  | { type: "error"; message: string };

export type PairMethod = "qr" | "code";

interface Pairing {
  events: PairEvent[];
  listeners: Set<(event: PairEvent) => void>;
  done: boolean;
  cancel: () => Promise<void>;
}

const SESSION = "default";
const SETTLE_MS = 1_500;
const pairings = new Map<string, Pairing>();
const testHooks = readTestHooks();

function readTestHooks() {
  const raw = process.env.PAIR_TEST_HOOKS;
  if (!raw) return {};
  const hooks = JSON.parse(raw) as { chatSocketUrls: string[]; noiseRootCa: { publicKey: string; serial: number } };
  return {
    chatSocketUrls: hooks.chatSocketUrls,
    testHooks: { noiseRootCa: { publicKey: Buffer.from(hooks.noiseRootCa.publicKey, "base64"), serial: hooks.noiseRootCa.serial } },
  };
}

const verbose = Boolean(process.env.PAIR_DEBUG);

const logger: Logger = {
  level: verbose ? "info" : "error",
  trace: () => {},
  debug: () => {},
  info: (message, context) => verbose && console.info("[zapo]", message, context ?? ""),
  warn: (message, context) => verbose && console.warn("[zapo]", message, context ?? ""),
  error: (message, context) => console.error("[zapo]", message, context ?? ""),
  child: () => logger,
};

export function activePairings(): number {
  return [...pairings.values()].filter((pairing) => !pairing.done).length;
}

export function subscribe(id: string, listener: (event: PairEvent) => void): (() => void) | null {
  const pairing = pairings.get(id);
  if (!pairing) return null;
  for (const event of pairing.events) listener(event);
  pairing.listeners.add(listener);
  return () => pairing.listeners.delete(listener);
}

export async function cancelPairing(id: string): Promise<void> {
  await pairings.get(id)?.cancel();
}

function maskPhone(jid: string): string {
  const phone = jid.split(/[:@]/)[0]!;
  return `+${phone.slice(0, 3)}${"•".repeat(Math.max(phone.length - 5, 3))}${phone.slice(-2)}`;
}

async function sendToOwnChat(client: WaClient, meJid: string, sessionId: string): Promise<void> {
  const chat = meJid.replace(/:\d+@/, "@");
  await client.message.send(chat, { type: "text", text: sessionId });
  await client.message.send(chat, {
    type: "text",
    text: "*Your session ID is above.*\nPut it in your bot as SESSION_ID.\nKeep it secret: anyone with it can use this WhatsApp account.",
  });
}

export function startPairing(method: PairMethod, phone: string): string {
  const id = crypto.randomUUID();
  const file = path.join(os.tmpdir(), `pair-${id}.db`);

  const store = createStore({
    backends: { sqlite: createSqliteStore({ path: file, driver: "auto" }) },
    providers: {
      auth: "sqlite",
      signal: "sqlite",
      preKey: "sqlite",
      session: "sqlite",
      identity: "sqlite",
      senderKey: "sqlite",
      appState: "sqlite",
      privacyToken: "sqlite",
      messages: "none",
      threads: "none",
      contacts: "none",
    },
  });
  const client = new WaClient(
    { store, sessionId: SESSION, history: { enabled: false }, deviceOsDisplayName: config.deviceName, ...testHooks },
    logger,
  );

  const pairing: Pairing = { events: [], listeners: new Set(), done: false, cancel: () => close() };
  pairings.set(id, pairing);

  let meJid: string | null = null;
  const timeout = setTimeout(() => void fail("Pairing timed out. Start again."), config.pairTimeoutMs);

  const emit = (event: PairEvent) => {
    pairing.events.push(event);
    for (const listener of pairing.listeners) listener(event);
  };

  const cleanup = async () => {
    await client.disconnect().catch(() => {});
    await store.destroy().catch(() => {});
    await Promise.all([file, `${file}-wal`, `${file}-shm`].map((name) => rm(name, { force: true })));
    // Late subscribers can still read the result for a minute.
    setTimeout(() => pairings.delete(id), 60_000);
  };

  async function close(): Promise<void> {
    if (pairing.done) return;
    pairing.done = true;
    clearTimeout(timeout);
    await cleanup();
  }

  async function fail(message: string): Promise<void> {
    if (pairing.done) return;
    emit({ type: "error", message });
    await close();
  }

  async function finish(): Promise<void> {
    if (pairing.done || !meJid) return;
    pairing.done = true;
    clearTimeout(timeout);

    const sessionId = newSessionId();
    try {
      if (config.sendToDm) await sendToOwnChat(client, meJid, sessionId).catch((error) => console.warn("Could not DM the session ID:", error));
      await Bun.sleep(SETTLE_MS);
      await client.disconnect();
      await store.destroy();

      const bundle = sealBundle(sessionId, zapoToBaileys(file, SESSION));
      await saveSession(lookupKey(sessionId), bundle);
      emit({ type: "success", sessionId, phone: maskPhone(meJid) });
    } catch (error) {
      emit({ type: "error", message: `Could not save the session: ${error instanceof Error ? error.message : error}` });
    } finally {
      await cleanup();
    }
  }

  client.on("auth_qr", async ({ qr }) => {
    if (method === "qr") emit({ type: "qr", qr, svg: await QRCode.toString(qr, { type: "svg", margin: 1 }) });
  });

  client.on("auth_pairing_required", async () => {
    if (method !== "code") return;
    try {
      emit({ type: "code", code: await client.auth.requestPairingCode(phone) });
    } catch (error) {
      await fail(`Could not get a pairing code: ${error instanceof Error ? error.message : error}`);
    }
  });

  client.on("auth_passkey_required", () => fail("This account needs a passkey to link devices, which is not supported."));

  client.on("auth_paired", ({ credentials }) => {
    meJid = credentials.meJid ?? null;
    emit({ type: "scanned" });
  });

  client.on("connection", (event) => {
    if (event.status === "open" && meJid) void finish();
    else if (event.status === "close" && event.isLogout) void fail("The phone cancelled the link.");
  });

  client.connect().catch((error) => fail(`Could not reach WhatsApp: ${error instanceof Error ? error.message : error}`));
  return id;
}
