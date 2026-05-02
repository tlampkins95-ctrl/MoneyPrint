import webpush from "web-push";
import { eq } from "drizzle-orm";
import { db, pushSubscriptionsTable, type PushSubscription } from "@workspace/db";
import { logger } from "./logger";

interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

let vapidConfig: VapidConfig | null = null;
let vapidConfigured = false;

// Lazy, idempotent VAPID setup. We re-read env on first call so a missing
// config at boot doesn't crash the whole server — push just stays disabled.
function getVapidConfig(): VapidConfig | null {
  if (vapidConfigured) return vapidConfig;
  vapidConfigured = true;

  const publicKey = process.env["VAPID_PUBLIC_KEY"];
  const privateKey = process.env["VAPID_PRIVATE_KEY"];
  const subject = process.env["VAPID_SUBJECT"] || "mailto:alerts@money.print";
  if (!publicKey || !privateKey) {
    logger.info("Web Push disabled (VAPID_PUBLIC_KEY/PRIVATE_KEY not set)");
    return null;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfig = { publicKey, privateKey, subject };
  return vapidConfig;
}

export function getVapidPublicKey(): string | null {
  return getVapidConfig()?.publicKey ?? null;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
  badge?: string;
  requireInteraction?: boolean;
}

// Returns true iff the kill-switch + VAPID config both allow sending.
// Exported so the control-plane routes (subscribe / unsubscribe / VAPID key)
// can refuse traffic the same way the broadcaster refuses to send — keeps
// "off" actually meaning off across the whole feature.
export function isWebPushEnabled(): boolean {
  const flag = process.env["ENABLE_WEB_PUSH"];
  if (flag === "false" || flag === "0") return false;
  return getVapidConfig() !== null;
}

// Push services return 404/410 when a subscription is permanently dead
// (browser uninstalled, user revoked permission). We delete those rows so
// the subscriber list stays clean and we don't burn CPU re-trying every tick.
function isGoneStatus(status: number | undefined): boolean {
  return status === 404 || status === 410;
}

async function deleteSubscription(endpoint: string): Promise<void> {
  try {
    await db
      .delete(pushSubscriptionsTable)
      .where(eq(pushSubscriptionsTable.endpoint, endpoint));
  } catch (err) {
    logger.warn({ err, endpoint }, "Failed to delete dead push subscription");
  }
}

export async function broadcastWebPush(payload: PushPayload): Promise<void> {
  if (!isWebPushEnabled()) return;

  let subs: PushSubscription[];
  try {
    subs = await db.select().from(pushSubscriptionsTable);
  } catch (err) {
    logger.warn({ err }, "Failed to load push subscriptions");
    return;
  }
  if (subs.length === 0) return;

  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subs.map((sub) =>
      webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        body,
        { TTL: 60 * 60 }, // 1h — signal staleness past that point
      ),
    ),
  );

  let sent = 0;
  let dropped = 0;
  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const sub = subs[i];
    if (r.status === "fulfilled") {
      sent++;
      continue;
    }
    const status = (r.reason as { statusCode?: number } | undefined)
      ?.statusCode;
    if (isGoneStatus(status)) {
      dropped++;
      await deleteSubscription(sub.endpoint);
    } else {
      failed++;
      logger.warn(
        { err: r.reason, status, endpoint: sub.endpoint },
        "Web Push send failed",
      );
    }
  }
  logger.info({ sent, dropped, failed, total: subs.length }, "Web Push fan-out complete");
}
