import {
  pgTable,
  serial,
  text,
  doublePrecision,
  bigint,
  timestamp,
} from "drizzle-orm/pg-core";

export const signalLogTable = pgTable("signal_log", {
  id:               serial("id").primaryKey().notNull(),
  key:              text("key").notNull(),
  symbol:           text("symbol").notNull(),
  timeframe:        text("timeframe").notNull(),
  signal:           text("signal").notNull(),
  signalType:       text("signal_type").notNull(),
  entryPrice:       doublePrecision("entry_price").notNull(),
  stopLoss:         doublePrecision("stop_loss").notNull(),
  takeProfit1:      doublePrecision("take_profit1").notNull(),
  takeProfit2:      doublePrecision("take_profit2").notNull(),
  riskRewardRatio:  doublePrecision("risk_reward_ratio").notNull(),
  signalReason:     text("signal_reason").notNull().default(""),
  firedAt:          bigint("fired_at", { mode: "number" }).notNull(),
  createdAt:        timestamp("created_at", { withTimezone: true }).defaultNow(),
});
