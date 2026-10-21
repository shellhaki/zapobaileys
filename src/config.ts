function text(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function number(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
  port: number("PORT", 3000),
  databaseUrl: text("DATABASE_URL", "sqlite://data/sessions.db"),
  sessionPrefix: text("SESSION_PREFIX", "PAIR"),
  deviceName: text("DEVICE_NAME", "Chrome (Linux)"),
  maxActivePairings: number("MAX_ACTIVE_PAIRINGS", 50),
  pairingsPerHour: number("PAIRINGS_PER_HOUR", 10),
  pairTimeoutMs: number("PAIR_TIMEOUT_SECONDS", 180) * 1000,
  sessionTtlDays: number("SESSION_TTL_DAYS", 90),
  trustProxy: text("TRUST_PROXY") === "true",
  sendToDm: text("SEND_TO_DM", "true") !== "false",
};
