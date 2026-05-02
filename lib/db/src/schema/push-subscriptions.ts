import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Stored Web Push (RFC 8030) subscriptions, one row per browser/device that
// has accepted notifications. The endpoint URL is unique per device per
// browser-vendor's push service (FCM / APNs gateway), so we use it as the
// primary key — re-subscribing the same device upserts the existing row.
export const pushSubscriptionsTable = pgTable("push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertPushSubscriptionSchema = createInsertSchema(
  pushSubscriptionsTable,
).omit({ createdAt: true, lastSeenAt: true });
export type InsertPushSubscription = z.infer<
  typeof insertPushSubscriptionSchema
>;
export type PushSubscription = typeof pushSubscriptionsTable.$inferSelect;
