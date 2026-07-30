import {
  pgTable,
  serial,
  text,
  doublePrecision,
  boolean,
  bigint,
  timestamp,
} from "drizzle-orm/pg-core";

// Alert-only outcome ledger for the FIB786 revision strategy. Kept separate
// from closed_trades (whose take_profit1/take_profit2/risk_reward_ratio
// columns are NOT NULL and assume a Phemex-executed trade) since this engine
// never places orders — the user executes manually.
export const fib786AlertsTable = pgTable("fib786_alerts", {
  id: serial("id").primaryKey(),
  key: text("key").notNull(),
  symbol: text("symbol").notNull(),
  entryPrice: doublePrecision("entry_price").notNull(),
  stopLoss: doublePrecision("stop_loss").notNull(),
  tp1: doublePrecision("tp1").notNull(),
  tp2: doublePrecision("tp2").notNull(),
  tp1Filled: boolean("tp1_filled").notNull().default(false),
  tp2Filled: boolean("tp2_filled").notNull().default(false),
  exitPrice: doublePrecision("exit_price"),
  outcome: text("outcome"), // FULL_SL | BE_AFTER_TP1 | TRAIL_STOP | MANUAL | null (still open)
  rMultiple: doublePrecision("r_multiple"),
  firedAt: bigint("fired_at", { mode: "number" }).notNull(),
  closedAt: bigint("closed_at", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export type Fib786Alert = typeof fib786AlertsTable.$inferSelect;
export type InsertFib786Alert = typeof fib786AlertsTable.$inferInsert;
