import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPrivateKey } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { FakeWaServer } from "@zapo-js/fake-server";
import * as baileys7 from "baileys";
import * as baileys6 from "baileys6";
import * as bunRestore from "../restore/restore-session.bun.ts";
import * as nodeRestore from "../restore/restore-session.node.ts";

const RESTORE_DIR = path.join(import.meta.dir, "../restore");
const load = (file: string): Promise<typeof nodeRestore> => import(path.join(RESTORE_DIR, file));
const variants: Record<string, typeof nodeRestore> = {
  "bun.ts": bunRestore,
  "node.ts": nodeRestore,
  mjs: await load("restore-session.mjs"),
  cjs: await load("restore-session.cjs"),
};
const { restoreSession, fetchSession } = bunRestore;

// @zapo-js/fake-server decodes ws close reasons, which Bun does not always pass as bytes.
const decode = TextDecoder.prototype.decode;
TextDecoder.prototype.decode = function (this: TextDecoder, input?: AllowSharedBufferSource | string, options?: TextDecodeOptions) {
  return input === undefined || typeof input === "string" ? (input ?? "") : decode.call(this, input, options);
} as typeof decode;

const BOT_DEVICE = "5511000000777:3@s.whatsapp.net";
const BOT_LID = "100000000000777:3@lid";
const PORT = 3917;
const API = `http://localhost:${PORT}`;

let wa: FakeWaServer;
let server: Subprocess;
let tmp: string;
let sessionId = "";

type Event = { type: string; qr?: string; sessionId?: string; phone?: string; message?: string };

async function readEvents(url: string, onEvent: (event: Event) => boolean): Promise<void> {
  const reader = (await fetch(url)).body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    text += decoder.decode(value);
    let split: number;
    while ((split = text.indexOf("\n\n")) >= 0) {
      const line = text.slice(0, split).split("\n").find((part) => part.startsWith("data:"));
      text = text.slice(split + 2);
      if (line && onEvent(JSON.parse(line.slice(5).trim()))) {
        await reader.cancel();
        return;
      }
    }
  }
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) return;
    await Bun.sleep(100);
  }
  throw new Error("pair-server did not start");
}

// Recomputes an X25519 public key from its private key.
function publicFromPrivate(privateKey: Buffer): Buffer {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), privateKey]);
  const jwk = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }).export({ format: "jwk" });
  return Buffer.from(jwk.x!, "base64url");
}

const withPrefix = (key: Uint8Array) => Buffer.concat([Buffer.from([5]), Buffer.from(key)]);

beforeAll(async () => {
  wa = await FakeWaServer.start();
  tmp = await mkdtemp(path.join(os.tmpdir(), "pair-server-test-"));
  server = Bun.spawn(["bun", "src/server.ts"], {
    cwd: path.join(import.meta.dir, ".."),
    stdout: "ignore",
    stderr: "inherit",
    env: {
      PATH: process.env.PATH ?? "",
      PORT: String(PORT),
      PAIR_DEBUG: process.env.PAIR_DEBUG ?? "",
      DATABASE_URL: `sqlite://${path.join(tmp, "sessions.db")}`,
      SESSION_PREFIX: "TEST",
      PAIR_TEST_HOOKS: JSON.stringify({
        chatSocketUrls: [wa.url],
        noiseRootCa: { publicKey: Buffer.from(wa.noiseRootCa.publicKey).toString("base64"), serial: wa.noiseRootCa.serial },
      }),
    },
  });
  await waitForServer();
});

afterAll(async () => {
  server?.kill();
  await wa?.stop();
  await rm(tmp, { recursive: true, force: true });
});

describe("pair-server", () => {
  test("rejects a pairing code request without a number", async () => {
    const response = await fetch(`${API}/api/pair`, { method: "POST", body: JSON.stringify({ method: "code", phone: "12" }) });
    expect(response.status).toBe(400);
  });

  test("pairs with zapo and hands out a session ID", async () => {
    const response = await fetch(`${API}/api/pair`, { method: "POST", body: JSON.stringify({ method: "qr" }) });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };

    let resolveQr: (qr: string) => void = () => {};
    const qr = new Promise<string>((resolve) => (resolveQr = resolve));
    const pairing = wa.waitForNextAuthenticatedPipeline(30_000).then((pipeline) =>
      wa.runPairing(pipeline, { deviceJid: BOT_DEVICE, deviceLid: BOT_LID }, async () => {
        const parts = (await qr).split(",");
        return { identityPublicKey: Buffer.from(parts[2]!, "base64"), advSecretKey: Buffer.from(parts[3]!, "base64") };
      }),
    );

    await readEvents(`${API}/api/pair/${id}/events`, (event) => {
      if (event.type === "qr") resolveQr(event.qr!);
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "success") {
        sessionId = event.sessionId!;
        expect(event.phone).toContain("•");
        return true;
      }
      return false;
    });
    await pairing;
    expect(sessionId).toMatch(/^TEST~[\w-]{43}$/);
  }, 60_000);

  test("the client restores it in one request, and skips when it already exists", async () => {
    const dir = path.join(tmp, "auth");
    const started = performance.now();
    const result = await restoreSession({ sessionId, server: API, dir });
    console.log(`restored ${result.files} files in ${Math.round(performance.now() - started)} ms`);

    const lookup = new Bun.CryptoHasher("sha256").update(sessionId).digest("hex");
    console.log(`bundle is ${((await (await fetch(`${API}/api/session/${lookup}`)).arrayBuffer()).byteLength / 1024).toFixed(0)} KB`);

    expect(result.restored).toBe(true);
    expect((await readdir(dir)).length).toBe(result.files);
    expect(await restoreSession({ sessionId, server: API, dir })).toMatchObject({ restored: false });
  });

  for (const [name, variant] of Object.entries(variants)) {
    test(`restore-session.${name} writes the same files`, async () => {
      const dir = path.join(tmp, `auth-${name}`);
      const result = await variant.restoreSession({ sessionId, server: API, dir });
      expect(result.restored).toBe(true);
      expect((await readdir(dir)).sort()).toEqual((await readdir(path.join(tmp, "auth"))).sort());
      expect(await Bun.file(path.join(dir, "creds.json")).text()).toBe(await Bun.file(path.join(tmp, "auth", "creds.json")).text());

      const { creds } = await variant.fetchSession({ sessionId, server: API });
      expect(Buffer.isBuffer((creds.noiseKey as { private: unknown }).private)).toBe(true);
    });
  }

  for (const file of ["restore-session.mjs", "restore-session.cjs", "restore-session.node.ts"]) {
    test(`${file} runs in Node`, async () => {
      const dir = path.join(tmp, `node-${file}`);
      const load = file.endsWith(".cjs") ? `require(${JSON.stringify(path.join(RESTORE_DIR, file))})` : `await import(${JSON.stringify(path.join(RESTORE_DIR, file))})`;
      const script = `const m = ${load}; const r = await m.restoreSession({ sessionId: process.env.SID, server: process.env.API, dir: process.env.DIR }); console.log(r.files);`;
      const flags = file.endsWith(".cjs") ? ["--input-type=commonjs", "-e", `(async () => { ${script} })()`] : ["--input-type=module", "-e", script];
      const proc = Bun.spawn(["node", ...flags], { env: { ...process.env, SID: sessionId, API, DIR: dir }, stdout: "pipe", stderr: "pipe" });
      expect(await proc.exited).toBe(0);
      expect(Number((await new Response(proc.stdout).text()).trim())).toBe((await readdir(path.join(tmp, "auth"))).length);
    });
  }

  test("fetchSession returns real Buffers for custom auth stores", async () => {
    const { creds, keys } = await fetchSession({ sessionId, server: API });
    expect(Buffer.isBuffer((creds.noiseKey as { private: unknown }).private)).toBe(true);
    expect(Buffer.isBuffer((keys["pre-key-1"] as { public: unknown }).public)).toBe(true);
  });

  test("a wrong session ID fails cleanly", async () => {
    const dir = path.join(tmp, "wrong");
    await expect(restoreSession({ sessionId: `${sessionId}x`, server: API, dir })).rejects.toThrow("Unknown or expired");
  });

  for (const [name, lib] of [["baileys 7", baileys7], ["baileys 6.7", baileys6]] as const) {
    test(`${name} loads the session and the keys check out`, async () => {
      const { state } = await lib.useMultiFileAuthState(path.join(tmp, "auth"));
      const { creds } = state;
      const { Curve } = lib as unknown as { Curve: { verify: (key: Uint8Array, message: Uint8Array, signature: Uint8Array) => boolean } };

      expect(creds.me?.id).toBe(BOT_DEVICE);
      expect(creds.me?.lid).toBe(BOT_LID);
      expect(creds.registered).toBe(true);

      for (const pair of [creds.noiseKey, creds.signedIdentityKey, creds.signedPreKey.keyPair, creds.pairingEphemeralKeyPair]) {
        expect(Buffer.isBuffer(pair.private)).toBe(true);
        expect(publicFromPrivate(pair.private as Buffer).equals(pair.public as Buffer)).toBe(true);
      }

      const identity = withPrefix(creds.signedIdentityKey.public);
      expect(Curve.verify(identity, withPrefix(creds.signedPreKey.keyPair.public), creds.signedPreKey.signature)).toBe(true);

      const account = creds.account!;
      const deviceMessage = Buffer.concat([
        Buffer.from([6, 1]),
        Buffer.from(account.details!),
        Buffer.from(creds.signedIdentityKey.public),
        Buffer.from(account.accountSignatureKey!),
      ]);
      expect(Curve.verify(identity, deviceMessage, account.deviceSignature!)).toBe(true);
      expect(creds.signalIdentities?.map((item) => item.identifier.name)).toEqual([BOT_DEVICE, BOT_LID]);

      const lastPreKey = String(creds.nextPreKeyId - 1);
      const keys = state.keys as baileys7.SignalKeyStore;
      const preKeys = await keys.get("pre-key", ["1", lastPreKey]);
      expect(preKeys["1"]).toBeDefined();
      expect(publicFromPrivate(preKeys[lastPreKey]!.private as Buffer).equals(preKeys[lastPreKey]!.public as Buffer)).toBe(true);
    });
  }
});
