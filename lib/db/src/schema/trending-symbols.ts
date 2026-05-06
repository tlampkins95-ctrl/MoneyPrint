import {
  pgTable,
  text,
  integer,
  doublePrecision,
  timestamp,
} from "drizzle-orm/pg-core";

export const trendingSymbolsTable = pgTable("trending_symbols", {
  symbolKey: text("symbol_key").primaryKey(),
  baseAsset: text("base_asset").notNull(),
  okxSymbol: text("okx_symbol").notNull(),
  phemexSymbol: text("phemex_symbol").notNull(),
  decimals: integer("decimals").notNull().default(4),
  minQty: doublePrecision("min_qty").notNull().default(1),
  qtyStep: doublePrecision("qty_step").notNull().default(1),
  priceChange24h: doublePrecision("price_change_24h").notNull().default(0),
  rank: integer("rank").notNull().default(999),
  discoveredAt: timestamp("discovered_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type TrendingSymbol = typeof trendingSymbolsTable.$inferSelect;
export type InsertTrendingSymbol = typeof trendingSymbolsTable.$inferInsert;
