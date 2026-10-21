# pair-server

Pair a WhatsApp account on a web page and get a **session ID** that any [Baileys](https://github.com/WhiskeySockets/Baileys) bot (6.7 and newer) turns into a working login with **one request**.

<p align="center">
  <img src="screenshots/speed.png" alt="A Baileys bot restoring 935 session files from pair-server in 38 ms" width="760">
</p>

<p align="center"><b>935 session files restored in 38 ms.</b> One request, no object storage.</p>

- **Pairing with [zapo](https://zapo.to):** fast, reliable QR and pairing-code linking.
- **One encrypted bundle per session:** the whole Baileys auth folder (`creds.json`, pre-keys, app-state keys) in about 115 KB. No object storage, no fetching hundreds of files one by one.
- **The bot restores in about 40 ms locally and about 100 ms over the internet:** one download, then parallel writes. Later starts are instant, because nothing is downloaded when `creds.json` exists.
- **Nothing to install in the bot:** copy one file (Bun, Node TS, ESM or CommonJS) from [`restore/`](restore).
- **The server cannot read sessions:** it stores only `sha256(sessionId)` and a blob encrypted with a key derived from the session ID.
- **The session ID is also sent to the user's own WhatsApp chat** after pairing, and shown on the page.

```
 phone ──scan──▶ pair-server (zapo) ──▶ converts to Baileys format ──▶ gzip + AES-256-GCM ──▶ sessions table
                       │
                       └──▶ session ID to the page and to the user's own WhatsApp chat

 bot ──GET /api/session/<sha256(id)>──▶ encrypted bundle ──▶ decrypt ──▶ ./auth/*.json ──▶ useMultiFileAuthState
```

## Why it is ridiculously faster

Most WhatsApp bot "session ID" systems upload the Baileys auth folder to object storage (S3, R2, Mega, a paste site) **file by file**. The folder is about 900 small files: `creds.json`, around 800 pre-keys, plus app-state keys. On every fresh start (and hosts like Render or Heroku wipe the disk on every deploy), the bot has to get them all back:

| | Usual approach | pair-server |
|---|---|---|
| HTTP requests per restore | **~900**: list, then one GET per file | **1** |
| Data transferred | ~900 responses, each with its own headers and round trip | **~115 KB**, one gzipped blob |
| Time | ~900 round trips. At 50 ms each, even 10 in parallel takes several seconds; one by one, over 40 s | **38 ms** locally, ~100 ms deployed |
| Storage | Bucket credentials inside every bot, or a third-party file host | One row in SQLite or Postgres |
| Failure modes | Rate limits, half-downloaded folders, expired links | One request with retries; `creds.json` written last, so a broken restore never looks like a session |
| Later starts | Often downloads again | **0 ms**: skipped when `creds.json` exists |

How it gets there:

1. **Convert once, at pairing time.** zapo pairs, and the server immediately builds the complete Baileys auth folder from zapo's store. The bot never converts anything.
2. **One blob per session.** The whole folder is serialized, gzipped and encrypted (AES-256-GCM) into one value. The server stores it ready to send.
3. **Zero work per fetch.** A fetch is a single key lookup, by `sha256(sessionId)`, that returns stored bytes. Recent sessions are kept in memory. The server does no crypto, no compression and no file listing.
4. **Parallel writes on the bot.** It decrypts in memory, then writes about 900 files 64 at a time, fast and safely under small hosts' open-file limits.
5. **Pairing with zapo.** Linking is fast and reliable, and many pairings run at once on one Bun process.

## Try it end to end

You need a phone with WhatsApp. The account you link becomes the bot.

```bash
# 1. Start the pair server
bun install
bun start                                   # http://localhost:3000

# 2. Open http://localhost:3000, link with QR or pairing code, copy the session ID
#    (it also arrives in your WhatsApp "Message yourself" chat)

# 3. Start the example Baileys bot with it
cd example-bot
bun install
SESSION_ID='PAIR~...' bun start             # or: SESSION_ID='PAIR~...' node index.ts
```

You should see:

```
✓ Restored 935 files from http://localhost:3000 in 38 ms   (numbers vary)
✓ Connected as 2348012345678:12@s.whatsapp.net
```

Then send `!ping` in any chat, for example *Message yourself*. The bot replies `pong 🏓`.

Restart the bot and it says `Using the existing auth/ folder`, because nothing is downloaded again. Delete `example-bot/auth` to test the restore again.

The bot in [`example-bot/index.ts`](example-bot/index.ts) follows Baileys' recommended setup: `fetchLatestBaileysVersion`, `makeCacheableSignalKeyStore`, a retry cache that survives reconnects, `getMessage` for resends, and reconnecting on every `DisconnectReason` except `loggedOut` and `connectionReplaced`.

## Run the server

Needs [Bun](https://bun.sh) 1.3 or newer.

```bash
git clone https://github.com/shellhaki/pair-server.git
cd pair-server
bun install
cp .env.example .env
bun start            # http://localhost:3000
```

With Docker:

```bash
docker build -t pair-server .
docker run -p 3000:3000 -v pair-data:/app/data --env-file .env pair-server
```

Sessions are stored in SQLite by default (`data/sessions.db`). Set `DATABASE_URL=postgres://...` to use Postgres instead. The table is created on start.

Put it behind HTTPS (Caddy, Traefik, Nginx, Cloudflare) and set `TRUST_PROXY=true` there.

### Settings

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `sqlite://data/sessions.db` | `sqlite://path` or `postgres://...` |
| `SESSION_PREFIX` | `PAIR` | Session IDs look like `PAIR~xxxx` |
| `DEVICE_NAME` | `Chrome (Linux)` | Name under *Linked devices* |
| `SEND_TO_DM` | `true` | Also send the session ID to the user's own chat |
| `MAX_ACTIVE_PAIRINGS` | `50` | Pairings running at once |
| `PAIRINGS_PER_HOUR` | `10` | Pairings per IP per hour |
| `PAIR_TIMEOUT_SECONDS` | `180` | How long a pairing may take |
| `SESSION_TTL_DAYS` | `90` | Sessions not fetched for this long are deleted |
| `TRUST_PROXY` | `false` | Read the client IP from `X-Forwarded-For` |
| `PAIR_DEBUG` | _(empty)_ | Print zapo connection logs |

## Use it in a Baileys bot

There is nothing to install. Copy the one file that matches your bot from [`restore/`](restore) into your project:

| Your bot | File |
|---|---|
| Bun (TypeScript or JS) | [`restore-session.bun.ts`](restore/restore-session.bun.ts) |
| Node + TypeScript (tsx, ts-node, Node 22+) | [`restore-session.node.ts`](restore/restore-session.node.ts) |
| Node, ES modules (`import`) | [`restore-session.mjs`](restore/restore-session.mjs) |
| Node, CommonJS (`require`) | [`restore-session.cjs`](restore/restore-session.cjs) |

Each file is standalone, has no dependencies, and is about 90 lines. Then add one call **before** `useMultiFileAuthState`:

```js
import makeWASocket, { useMultiFileAuthState } from "baileys";
import { restoreSession } from "./restore-session.mjs";

await restoreSession({
  sessionId: process.env.SESSION_ID,
  server: "https://pair.example.com",
  dir: "./auth",
});

const { state, saveCreds } = await useMultiFileAuthState("./auth");
const sock = makeWASocket({ auth: state });
sock.ev.on("creds.update", saveCreds);
```

CommonJS:

```js
const { default: makeWASocket, useMultiFileAuthState } = require("baileys");
const { restoreSession } = require("./restore-session.cjs");
```

That is the whole integration:

- **First start:** downloads the session and writes `./auth`.
- **Later starts:** `./auth/creds.json` exists, so it returns immediately and Baileys continues from its own files.
- **Hosts that wipe the disk (Render, Heroku, ...):** every start restores again from the session ID.
- **Bots that keep auth in Mongo, Redis or Postgres:** use `fetchSession` and write the data into your own store.

```js
import { fetchSession } from "./restore-session.mjs";

const { creds, keys } = await fetchSession({ sessionId, server });
// creds: the creds.json object, Buffers included
// keys:  { "pre-key-1": {...}, "app-state-sync-key-AAAA": {...}, ... }
```

`restoreSession` returns `{ restored, dir, files }`. Pass `force: true` to download again even when `creds.json` exists.

| Error | Meaning |
|---|---|
| `Unknown or expired session ID.` | Not on that server, or deleted after not being used |
| `Could not decrypt the session...` | The session ID is incomplete or wrong |
| `Pair server answered 5xx.` | Server problem; the file already retried 3 times |

More: [`examples/`](examples).

## API

| Route | |
|---|---|
| `GET /` | Pair page |
| `POST /api/pair` | `{ "method": "qr" }` or `{ "method": "code", "phone": "2348012345678" }` → `{ "id" }` |
| `GET /api/pair/:id/events` | Server-sent events: `qr` (with `svg`), `code`, `scanned`, `success` (`sessionId`, masked `phone`), `error` |
| `DELETE /api/pair/:id` | Cancel a pairing |
| `GET /api/session/:lookup` | The encrypted bundle, where `lookup = sha256(sessionId)` in hex |
| `DELETE /api/session/:lookup` | Delete a stored session |
| `GET /health` | `{ ok, pairing }` |

## Bundle format (v1)

Anyone can write a client in another language:

1. `lookup = hex(sha256(sessionId))`, then `GET /api/session/<lookup>`.
2. Body = `nonce (12 bytes) | ciphertext | tag (16 bytes)`.
3. `key = HKDF-SHA256(ikm = sessionId, salt = "pair-server/v1", info = "bundle", 32 bytes)`.
4. AES-256-GCM decrypt, gunzip, parse JSON: `{ "v": 1, "files": { "creds": {...}, "pre-key-1": {...}, ... } }`.
5. Values are already in Baileys' `BufferJSON` form (`{ "type": "Buffer", "data": "<base64>" }`).
6. Write each entry to `<name>.json`, with `/` replaced by `__` and `:` by `-`, and write `creds.json` last.

## What gets converted

zapo's SQLite store after pairing becomes:

- `creds.json`: noise key, identity key, signed pre-key, registration ID, adv secret, `me` (JID, LID, name), signed `account`, `signalIdentities` (keyed by JID for v6 and by LID for v7), pre-key counters, platform and routing info
- `pre-key-<id>.json`: every pre-key zapo uploaded to WhatsApp
- `app-state-sync-key-<id>.json`: app-state keys received during pairing

Signal sessions and group sender keys are not converted: their storage formats differ, and Baileys rebuilds them on its own. That is why, right after the first start, Baileys' info logs may show `No session found to decrypt message` for a few chats. Baileys asks the sender's phone to resend, and the message arrives a moment later.

## Security

- **A session ID is a full login.** Anyone who has it can read and send messages as that number. Tell users never to share it.
- **What the server stores:** only the lookup hash and the encrypted bundle. A database dump without the session IDs is useless.
- **The server does see the session ID once, while pairing.** That is when it creates and encrypts the bundle. Run your own instance if you do not want to trust a public one.
- **One device, one client.** After pairing, zapo disconnects cleanly. Run only one bot per session ID, or WhatsApp will log one of them out.

## Development

```bash
bun test          # pairs against a fake WhatsApp server, restores with all four files, loads the result in Baileys 6.7 and 7
bun run typecheck
```

The restore files live in [`restore/`](restore). Keep the four in sync; the tests check that they write identical output and run in Node.

## Support

If this saves you time, **star the repo ⭐**. It helps other people find it.

You can also support my work at **[myhappr.com/haki](https://myhappr.com/haki)**. Thank you!

## License

MIT
