const { default: makeWASocket, useMultiFileAuthState } = require("baileys");
const { restoreSession } = require("../restore/restore-session.cjs");

async function start() {
  await restoreSession({ sessionId: process.env.SESSION_ID, server: process.env.PAIR_SERVER, dir: "./auth" });

  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const sock = makeWASocket({ auth: state });
  sock.ev.on("creds.update", saveCreds);
}

start();
