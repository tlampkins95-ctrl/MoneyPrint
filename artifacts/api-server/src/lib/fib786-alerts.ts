// State/persistence layer for the FIB786 alert-only engine. Parallel to (not
// reusing) signals.ts's activeTrades Map — that structure assumes a Phemex-
// executed trade with non-null TP1/TP2/riskRewardRatio; this engine never
// places orders, so it keeps its own simpler alert-lifecycle state.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { logger } from "./logger";

export type Fib786Outcome = "FULL_SL" | "BE_AFTER_TP1" | "TRAIL_STOP" | "MANUAL";

export interface Fib786AlertState {
  symbolKey: string;
  entryPrice: number;
  stopLoss: number;    // current/moving stop — breakeven after TP1, then trailing after TP2
  initialSl: number;
  tp1: number;
  tp2: number;
  tp1Filled: boolean;
  tp2Filled: boolean;
  firedAt: number;
  lastUpdateAt: number;
}

const activeAlerts = new Map<string, Fib786AlertState>();

const DB_NAMESPACE = process.env["NODE_ENV"] === "production" ? "production" : "dev";
const ALERTS_FILE =
  process.env["FIB786_ALERTS_FILE"] ??
  join(process.cwd(), ".runtime", "fib786-alerts.json");

let _pool: Pool | null = null;
function getPool(): Pool | null {
  if (!process.env["DATABASE_URL"]) return null;
  if (!_pool) _pool = new Pool({ connectionString: process.env["DATABASE_URL"], ssl: { rejectUnauthorized: false } });
  return _pool;
}

function alertKey(symbolKey: string): string {
  return `${DB_NAMESPACE}::${symbolKey}`;
}

export function getActiveAlert(symbolKey: string): Fib786AlertState | undefined {
  return activeAlerts.get(alertKey(symbolKey));
}

export function getAllActiveAlerts(): Fib786AlertState[] {
  return Array.from(activeAlerts.values());
}

export function setActiveAlert(state: Fib786AlertState): void {
  activeAlerts.set(alertKey(state.symbolKey), state);
  persistActiveAlerts();
}

export function clearActiveAlert(symbolKey: string): void {
  activeAlerts.delete(alertKey(symbolKey));
  persistActiveAlerts();
}

function persistActiveAlerts(): void {
  try {
    mkdirSync(dirname(ALERTS_FILE), { recursive: true });
    const obj: Record<string, Fib786AlertState> = {};
    for (const [k, v] of activeAlerts) obj[k] = v;
    writeFileSync(ALERTS_FILE, JSON.stringify(obj));
  } catch {
    // best-effort — local file is a convenience cache, not the source of truth
  }
}

export function loadActiveAlertsFromDisk(): void {
  try {
    const raw = readFileSync(ALERTS_FILE, "utf-8");
    const obj = JSON.parse(raw) as Record<string, Fib786AlertState>;
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith(`${DB_NAMESPACE}::`)) activeAlerts.set(k, v);
    }
  } catch {
    // no file yet, or unreadable — start fresh
  }
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS fib786_alerts (
    id serial PRIMARY KEY,
    key text NOT NULL,
    symbol text NOT NULL,
    entry_price double precision NOT NULL,
    stop_loss double precision NOT NULL,
    tp1 double precision NOT NULL,
    tp2 double precision NOT NULL,
    tp1_filled boolean NOT NULL DEFAULT false,
    tp2_filled boolean NOT NULL DEFAULT false,
    exit_price double precision,
    outcome text,
    r_multiple double precision,
    fired_at bigint NOT NULL,
    closed_at bigint,
    created_at timestamptz DEFAULT NOW()
  )
`;

async function ensureTable(pool: Pool): Promise<void> {
  await pool.query(CREATE_TABLE_SQL);
}

// Best-effort — logging failures never block the alert engine itself.
export async function logFib786Outcome(
  state: Fib786AlertState,
  exitPrice: number,
  outcome: Fib786Outcome,
  rMultiple: number,
): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await ensureTable(pool);
    await pool.query(
      `INSERT INTO fib786_alerts
         (key, symbol, entry_price, stop_loss, tp1, tp2, tp1_filled, tp2_filled, exit_price, outcome, r_multiple, fired_at, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        alertKey(state.symbolKey), state.symbolKey, state.entryPrice, state.initialSl,
        state.tp1, state.tp2, state.tp1Filled, state.tp2Filled,
        exitPrice, outcome, rMultiple, state.firedAt, Date.now(),
      ],
    );
  } catch (err) {
    logger.warn({ err }, "Failed to log FIB786 alert outcome");
  }
}

loadActiveAlertsFromDisk();
