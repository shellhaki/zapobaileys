import { Database } from "bun:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { proto } from "zapo-js";

export type BaileysFiles = Record<string, unknown>;

interface CredentialsRow {
  noise_pub_key: Uint8Array;
  noise_priv_key: Uint8Array;
  registration_id: number;
  identity_pub_key: Uint8Array;
  identity_priv_key: Uint8Array;
  signed_prekey_id: number;
  signed_prekey_pub_key: Uint8Array;
  signed_prekey_priv_key: Uint8Array;
  signed_prekey_signature: Uint8Array;
  adv_secret_key: Uint8Array;
  signed_identity: Uint8Array | null;
  me_jid: string | null;
  me_lid: string | null;
  push_name: string | null;
  platform: string | null;
  routing_info: Uint8Array | null;
}

interface PreKeyRow {
  key_id: number;
  pub_key: Uint8Array;
  priv_key: Uint8Array;
  uploaded: number;
}

interface AppStateKeyRow {
  key_id: Uint8Array;
  key_data: Uint8Array;
  timestamp: number;
  fingerprint: Uint8Array | null;
}

const buffer = (bytes: Uint8Array) => Buffer.from(bytes);

function keyPair(publicKey: Uint8Array, privateKey: Uint8Array) {
  return { private: buffer(privateKey), public: buffer(publicKey) };
}

function newKeyPair() {
  const { privateKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  return keyPair(Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.d!, "base64url"));
}

// Baileys keeps signal public keys with the 0x05 type prefix.
function signalKey(publicKey: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([5]), buffer(publicKey)]);
}

// Reads a zapo SQLite store right after pairing and returns the Baileys multi-file auth state.
export function zapoToBaileys(file: string, sessionId = "default"): BaileysFiles {
  const db = new Database(file, { readonly: true });
  try {
    const creds = db.query<CredentialsRow, [string]>("SELECT * FROM auth_credentials WHERE session_id = ?").get(sessionId);
    if (!creds?.me_jid || !creds.signed_identity) throw new Error("The store has no paired account.");

    // zapo creates tables on first use, so some may not exist yet.
    const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    const preKeys = tables.has("signal_prekey")
      ? db.query<PreKeyRow, [string]>("SELECT key_id, pub_key, priv_key, uploaded FROM signal_prekey WHERE session_id = ? ORDER BY key_id").all(sessionId)
      : [];
    const appStateKeys = tables.has("appstate_sync_keys")
      ? db
          .query<AppStateKeyRow, [string]>("SELECT key_id, key_data, timestamp, fingerprint FROM appstate_sync_keys WHERE session_id = ? ORDER BY timestamp")
          .all(sessionId)
      : [];

    const account = proto.ADVSignedDeviceIdentity.decode(creds.signed_identity);
    if (!account.accountSignatureKey) throw new Error("The paired account has no signature key.");
    const accountKey = signalKey(account.accountSignatureKey);

    // v6 looks the phone's identity up by JID, v7 by LID: include both.
    const signalIdentities = [creds.me_jid, creds.me_lid]
      .filter((jid): jid is string => Boolean(jid))
      .map((jid) => ({ identifier: { name: jid, deviceId: 0 }, identifierKey: accountKey }));

    const lastUploaded = Math.max(0, ...preKeys.filter((key) => key.uploaded).map((key) => key.key_id));
    const lastKey = Math.max(0, ...preKeys.map((key) => key.key_id));
    const latestAppStateKey = appStateKeys.at(-1);

    const files: BaileysFiles = {
      creds: {
        noiseKey: keyPair(creds.noise_pub_key, creds.noise_priv_key),
        pairingEphemeralKeyPair: newKeyPair(),
        signedIdentityKey: keyPair(creds.identity_pub_key, creds.identity_priv_key),
        signedPreKey: {
          keyPair: keyPair(creds.signed_prekey_pub_key, creds.signed_prekey_priv_key),
          signature: buffer(creds.signed_prekey_signature),
          keyId: creds.signed_prekey_id,
        },
        registrationId: creds.registration_id,
        advSecretKey: buffer(creds.adv_secret_key).toString("base64"),
        me: { id: creds.me_jid, lid: creds.me_lid ?? undefined, name: creds.push_name ?? undefined },
        account: {
          details: buffer(account.details!),
          accountSignatureKey: buffer(account.accountSignatureKey),
          accountSignature: buffer(account.accountSignature!),
          deviceSignature: buffer(account.deviceSignature!),
        },
        signalIdentities,
        myAppStateKeyId: latestAppStateKey ? buffer(latestAppStateKey.key_id).toString("base64") : undefined,
        firstUnuploadedPreKeyId: lastUploaded + 1,
        nextPreKeyId: lastKey + 1,
        platform: creds.platform ?? undefined,
        processedHistoryMessages: [],
        accountSyncCounter: 0,
        accountSettings: { unarchiveChats: false },
        registered: true,
        pairingCode: undefined,
        lastPropHash: undefined,
        routingInfo: creds.routing_info ? buffer(creds.routing_info) : undefined,
      },
    };

    for (const key of preKeys) {
      files[`pre-key-${key.key_id}`] = keyPair(key.pub_key, key.priv_key);
    }

    for (const key of appStateKeys) {
      const fingerprint = key.fingerprint ? proto.Message.AppStateSyncKeyFingerprint.decode(key.fingerprint) : undefined;
      files[`app-state-sync-key-${buffer(key.key_id).toString("base64")}`] = {
        keyData: buffer(key.key_data),
        fingerprint: fingerprint && {
          rawId: fingerprint.rawId,
          currentIndex: fingerprint.currentIndex,
          deviceIndexes: fingerprint.deviceIndexes,
        },
        timestamp: key.timestamp,
      };
    }

    return files;
  } finally {
    db.close();
  }
}
