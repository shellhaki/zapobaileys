import { mkdir } from "node:fs/promises";
import path from "node:path";
import { SQL } from "bun";
import { config } from "./config.ts";

const CACHE_SIZE = 500;

let db: SQL;
const cache = new Map<string, Uint8Array>();

function remember(key: string, bundle: Uint8Array): void {
  cache.delete(key);
  cache.set(key, bundle);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}

export async function openStore(): Promise<void> {
  const url = config.databaseUrl;
  if (url.startsWith("sqlite://")) {
    const file = url.slice("sqlite://".length);
    await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    db = new SQL({ adapter: "sqlite", filename: file });
  } else {
    db = new SQL(url);
  }

  await db`
    CREATE TABLE IF NOT EXISTS sessions (
      lookup TEXT PRIMARY KEY,
      bundle BYTEA NOT NULL,
      created_at BIGINT NOT NULL,
      fetched_at BIGINT
    )`;
}

export async function saveSession(lookup: string, bundle: Uint8Array): Promise<void> {
  await db`INSERT INTO sessions (lookup, bundle, created_at) VALUES (${lookup}, ${bundle}, ${Date.now()})`;
  remember(lookup, bundle);
}

export async function loadSession(lookup: string): Promise<Uint8Array | null> {
  let bundle = cache.get(lookup) ?? null;
  if (!bundle) {
    const [row] = await db`SELECT bundle FROM sessions WHERE lookup = ${lookup}`;
    if (!row) return null;
    bundle = new Uint8Array(row.bundle);
    remember(lookup, bundle);
  }
  void db`UPDATE sessions SET fetched_at = ${Date.now()} WHERE lookup = ${lookup}`.catch(() => {});
  return bundle;
}

export async function deleteSession(lookup: string): Promise<boolean> {
  cache.delete(lookup);
  const rows = await db`DELETE FROM sessions WHERE lookup = ${lookup} RETURNING lookup`;
  return rows.length > 0;
}

// Drops sessions nobody fetched for SESSION_TTL_DAYS.
export async function pruneSessions(): Promise<void> {
  const cutoff = Date.now() - config.sessionTtlDays * 86_400_000;
  await db`DELETE FROM sessions WHERE COALESCE(fetched_at, created_at) < ${cutoff}`;
  cache.clear();
}
