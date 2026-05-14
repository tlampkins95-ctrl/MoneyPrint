import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const activeTradesTable = pgTable("active_trades", {
  key: text("key").primaryKey().notNull(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
