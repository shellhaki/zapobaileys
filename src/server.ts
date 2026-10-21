import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { config } from "./config.ts";
import { activePairings, cancelPairing, startPairing, subscribe, type PairEvent } from "./pair.ts";
import { deleteSession, loadSession, openStore, pruneSessions } from "./store.ts";

const app = new Hono();
const pairsByIp = new Map<string, number[]>();

function clientIp(c: Context): string {
  const forwarded = config.trustProxy ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() : undefined;
  return forwarded || c.env?.requestIP?.(c.req.raw)?.address || "unknown";
}

function allowPairing(ip: string): boolean {
  const hourAgo = Date.now() - 3_600_000;
  const recent = (pairsByIp.get(ip) ?? []).filter((at) => at > hourAgo);
  if (recent.length >= config.pairingsPerHour) return false;
  pairsByIp.set(ip, [...recent, Date.now()]);
  return true;
}

app.get("/health", (c) => c.json({ ok: true, pairing: activePairings() }));

app.post("/api/pair", async (c) => {
  const body = await c.req.json<{ method?: string; phone?: string }>().catch(() => ({}) as { method?: string; phone?: string });
  const method = body.method === "code" ? "code" : "qr";
  const phone = (body.phone ?? "").replace(/\D/g, "");

  if (method === "code" && (phone.length < 7 || phone.length > 15)) {
    return c.json({ error: "Enter your number with country code, digits only." }, 400);
  }
  if (activePairings() >= config.maxActivePairings) return c.json({ error: "Too many people are pairing right now. Try again in a minute." }, 503);
  if (!allowPairing(clientIp(c))) return c.json({ error: "Too many pairings from your network. Try again later." }, 429);

  return c.json({ id: startPairing(method, phone) }, 201);
});

app.get("/api/pair/:id/events", (c) =>
  streamSSE(c, async (stream) => {
    const queue: PairEvent[] = [];
    let wake: () => void = () => {};
    const unsubscribe = subscribe(c.req.param("id"), (event) => {
      queue.push(event);
      wake();
    });
    if (!unsubscribe) {
      await stream.writeSSE({ data: JSON.stringify({ type: "error", message: "Unknown pairing." }) });
      return;
    }
    stream.onAbort(unsubscribe);

    while (!stream.aborted) {
      if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
      const event = queue.shift()!;
      await stream.writeSSE({ data: JSON.stringify(event) });
      if (event.type === "success" || event.type === "error") break;
    }
    unsubscribe();
  }),
);

app.delete("/api/pair/:id", async (c) => {
  await cancelPairing(c.req.param("id"));
  return c.body(null, 204);
});

app.get("/api/session/:lookup", async (c) => {
  const lookup = c.req.param("lookup");
  if (!/^[a-f0-9]{64}$/.test(lookup)) return c.json({ error: "Bad session lookup." }, 400);
  const bundle = await loadSession(lookup);
  if (!bundle) return c.json({ error: "Unknown or expired session ID." }, 404);
  return c.body(bundle as Uint8Array<ArrayBuffer>, 200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
});

app.delete("/api/session/:lookup", async (c) => {
  const deleted = await deleteSession(c.req.param("lookup"));
  return deleted ? c.body(null, 204) : c.json({ error: "Unknown session." }, 404);
});

app.get("/", () => new Response(Bun.file(new URL("../public/index.html", import.meta.url))));

await openStore();
await pruneSessions();
setInterval(() => void pruneSessions().catch(() => {}), 3_600_000);

const server = Bun.serve({ port: config.port, fetch: (request, server) => app.fetch(request, server), idleTimeout: 0 });
console.log(`pair-server listening on :${server.port}`);
