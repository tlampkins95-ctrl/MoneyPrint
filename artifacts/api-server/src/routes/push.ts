import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetVapidPublicKeyResponse,
  SubscribePushResponse,
  UnsubscribePushResponse,
} from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import { db, pushSubscriptionsTable } from "@workspace/db";
import {
  getVapidPublicKey,
  isWebPushEnabled,
} from "../lib/web-push-notifier";

const router: IRouter = Router();

// --- Validation -------------------------------------------------------------
// Push services use a small, well-known set of hosts. Allow-listing them
// blocks attackers from poisoning the table with arbitrary URLs that the
// server would then dutifully POST signed payloads to on every signal tick.
const ALLOWED_PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^.*\.push\.services\.mozilla\.com$/,
  /^updates(?:-[a-z0-9]+)?\.push\.apple\.com$/,
  /^.*\.notify\.windows\.com$/,
];

// Base64url, no padding, bounded length. Keys are fixed-size in the spec but
// we leave generous headroom so future curves don't break us.
const BASE64URL = /^[A-Za-z0-9_-]+$/;

interface ParsedSubscribe {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

function isHttpsAllowedEndpoint(s: string): boolean {
  if (typeof s !== "string" || s.length < 20 || s.length > 2048) return false;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return false;
    return ALLOWED_PUSH_HOSTS.some((re) => re.test(u.host));
  } catch {
    return false;
  }
}

function isB64Url(v: unknown, min: number, max: number): boolean {
  return (
    typeof v === "string" &&
    v.length >= min &&
    v.length <= max &&
    BASE64URL.test(v)
  );
}

function parseSubscribe(body: unknown): ParsedSubscribe | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.endpoint !== "string" || !isHttpsAllowedEndpoint(b.endpoint)) {
    return null;
  }
  const keys = b.keys;
  if (!keys || typeof keys !== "object") return null;
  const k = keys as Record<string, unknown>;
  if (!isB64Url(k.p256dh, 40, 200)) return null;
  if (!isB64Url(k.auth, 8, 64)) return null;
  let ua: string | undefined;
  if (typeof b.userAgent === "string") {
    if (b.userAgent.length > 500) return null;
    ua = b.userAgent;
  }
  return {
    endpoint: b.endpoint,
    keys: { p256dh: k.p256dh as string, auth: k.auth as string },
    userAgent: ua,
  };
}

function parseUnsubscribe(body: unknown): { endpoint: string } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  // Unsubscribe accepts any HTTPS URL (we want to allow removing rows that
  // pre-date the host allowlist tightening). Just sanity-check shape.
  if (typeof b.endpoint !== "string") return null;
  if (b.endpoint.length < 20 || b.endpoint.length > 2048) return null;
  try {
    const u = new URL(b.endpoint);
    if (u.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { endpoint: b.endpoint };
}

// --- Origin lockdown --------------------------------------------------------
// Global CORS is wide-open by design (most routes are read-only public data),
// but the push control plane writes to the DB and signs delivery to user
// devices, so we narrow it here. Block any cross-origin POST whose Origin
// isn't one of our published domains. Same-origin requests omit Origin or
// match REPLIT_DOMAINS / REPLIT_DEV_DOMAIN — both are accepted.
function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers["origin"];
  if (!origin) return true; // same-origin browsers and curl

  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }

  const allowed = new Set<string>();
  const prod = process.env["REPLIT_DOMAINS"];
  if (prod) {
    for (const d of prod.split(",")) {
      const t = d.trim();
      if (t) allowed.add(t);
    }
  }
  const dev = process.env["REPLIT_DEV_DOMAIN"];
  if (dev) allowed.add(dev.trim());
  // Localhost preview during development.
  allowed.add("localhost");
  allowed.add("127.0.0.1");

  return Array.from(allowed).some(
    (d) => host === d || host.startsWith(d + ":") || host === `localhost`,
  );
}

// --- Routes -----------------------------------------------------------------
router.get("/push/vapid-public-key", (_req: Request, res: Response) => {
  if (!isWebPushEnabled()) {
    res.status(503).json({ error: "Web Push is disabled on this server" });
    return;
  }
  const publicKey = getVapidPublicKey();
  if (!publicKey) {
    res.status(503).json({ error: "Web Push is not configured on this server" });
    return;
  }
  res.json(GetVapidPublicKeyResponse.parse({ publicKey }));
});

router.post("/push/subscribe", async (req: Request, res: Response) => {
  if (!isWebPushEnabled()) {
    res.status(503).json({ error: "Web Push is disabled on this server" });
    return;
  }
  if (!isAllowedOrigin(req)) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }

  // Schema errors are 400; anything else (DB outage, etc.) is 500. The
  // architect review specifically called out conflating these — splitting
  // them keeps observability and retry semantics clean.
  const body = parseSubscribe(req.body);
  if (!body) {
    res.status(400).json({ error: "Invalid push subscription payload" });
    return;
  }

  try {
    const userAgent =
      body.userAgent || req.headers["user-agent"]?.slice(0, 500) || null;
    await db
      .insert(pushSubscriptionsTable)
      .values({
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent,
      })
      .onConflictDoUpdate({
        target: pushSubscriptionsTable.endpoint,
        set: {
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          userAgent,
          lastSeenAt: new Date(),
        },
      });
    res.json(SubscribePushResponse.parse({ ok: true }));
  } catch (err) {
    req.log.error({ err }, "Failed to store push subscription");
    res.status(500).json({ error: "Failed to store push subscription" });
  }
});

router.post("/push/unsubscribe", async (req: Request, res: Response) => {
  if (!isWebPushEnabled()) {
    res.status(503).json({ error: "Web Push is disabled on this server" });
    return;
  }
  if (!isAllowedOrigin(req)) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }

  const body = parseUnsubscribe(req.body);
  if (!body) {
    res.status(400).json({ error: "Invalid unsubscribe payload" });
    return;
  }

  try {
    await db
      .delete(pushSubscriptionsTable)
      .where(eq(pushSubscriptionsTable.endpoint, body.endpoint));
    res.json(UnsubscribePushResponse.parse({ ok: true }));
  } catch (err) {
    req.log.error({ err }, "Failed to delete push subscription");
    res.status(500).json({ error: "Failed to delete push subscription" });
  }
});

export default router;
