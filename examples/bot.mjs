import makeWASocket, { useMultiFileAuthState } from "baileys";
import { restoreSession } from "../restore/restore-session.mjs";

// One request on the first start; instant when ./auth already exists.
await restoreSession({
  sessionId: process.env.SESSION_ID,
  server: process.env.PAIR_SERVER,
  dir: "./auth",
});

const { state, saveCreds } = await useMultiFileAuthState("./auth");
const sock = makeWASocket({ auth: state });
sock.ev.on("creds.update", saveCreds);

sock.ev.on("connection.update", ({ connection }) => {
  if (connection === "open") console.log("Connected");
});

sock.ev.on("messages.upsert", async ({ messages }) => {
  const message = messages[0];
  const text = message?.message?.conversation;
  if (text === "ping") await sock.sendMessage(message.key.remoteJid, { text: "pong" }, { quoted: message });
});
