import { useEffect, useState } from "react";
import { Bell, BellOff, BellRing } from "lucide-react";
import {
  useGetVapidPublicKey,
  getGetVapidPublicKeyQueryKey,
  subscribePush,
  unsubscribePush,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

type State =
  | "unsupported"
  | "denied"
  | "loading"
  | "off"
  | "on"
  | "saving";

// Web Push uses raw urlsafe-base64 for the application server key. The
// browser's PushManager.subscribe wants a Uint8Array, so decode here.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return window
    .btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function PushNotificationsToggle() {
  const [state, setState] = useState<State>("loading");
  const [error, setError] = useState<string | null>(null);

  // Pull VAPID key lazily — only when the user has a supported browser. The
  // server returns 503 when not configured, in which case the toggle hides.
  const vapid = useGetVapidPublicKey({
    query: {
      queryKey: getGetVapidPublicKeyQueryKey(),
      enabled: state !== "unsupported",
      retry: false,
    },
  });

  // Boot: detect support, register the service worker, then check whether
  // we already have an active subscription so the button reflects reality.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isSupported()) {
        setState("unsupported");
        return;
      }
      if (Notification.permission === "denied") {
        setState("denied");
        return;
      }
      try {
        // Register at the app's base URL so SW scope covers the whole UI.
        // Vite serves /sw.js from /public.
        const reg =
          (await navigator.serviceWorker.getRegistration()) ||
          (await navigator.serviceWorker.register(
            `${import.meta.env.BASE_URL}sw.js`,
          ));
        const existing = await reg.pushManager.getSubscription();
        if (cancelled) return;
        setState(existing ? "on" : "off");
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message || "Push registration failed");
        setState("off");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function turnOn() {
    setError(null);
    setState("saving");
    try {
      if (Notification.permission === "default") {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") {
          setState(perm === "denied" ? "denied" : "off");
          return;
        }
      }

      const publicKey = vapid.data?.publicKey;
      if (!publicKey) {
        // Force a refetch in case the user hit Subscribe before the GET resolved.
        const r = await vapid.refetch();
        if (!r.data?.publicKey) {
          setError("Server has no VAPID key configured");
          setState("off");
          return;
        }
      }
      const finalKey = vapid.data?.publicKey ?? (await vapid.refetch()).data?.publicKey;
      if (!finalKey) {
        setError("VAPID key unavailable");
        setState("off");
        return;
      }

      const reg = await navigator.serviceWorker.ready;
      // Cast: the lib.dom type signature for applicationServerKey is narrower
      // than what runtimes accept (Uint8Array works everywhere). The DOM lib
      // wants a plain ArrayBuffer view, so widen via BufferSource.
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(finalKey) as unknown as BufferSource,
      });

      const json = subscription.toJSON() as {
        endpoint?: string;
        keys?: { p256dh?: string; auth?: string };
      };
      // toJSON gives base64url already, but fall back to manual encoding from
      // getKey() for browsers that ever drift from the spec.
      const p256dh =
        json.keys?.p256dh ??
        arrayBufferToBase64Url(subscription.getKey("p256dh"));
      const auth =
        json.keys?.auth ??
        arrayBufferToBase64Url(subscription.getKey("auth"));
      const endpoint = json.endpoint || subscription.endpoint;

      await subscribePush({
        endpoint,
        keys: { p256dh, auth },
        userAgent: navigator.userAgent,
      });
      setState("on");
    } catch (err) {
      setError((err as Error).message || "Failed to enable notifications");
      setState("off");
    }
  }

  async function turnOff() {
    setError(null);
    setState("saving");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe().catch(() => undefined);
        await unsubscribePush({ endpoint }).catch(() => undefined);
      }
      setState("off");
    } catch (err) {
      setError((err as Error).message || "Failed to disable notifications");
      setState("on");
    }
  }

  if (state === "unsupported") return null;
  // Server has no VAPID key — hide the toggle entirely. 503 surfaces as a
  // failed query with no data; treating any error as "hidden" avoids flashing
  // a broken button at users.
  if (vapid.isError) return null;

  const isOn = state === "on";
  const busy = state === "loading" || state === "saving";

  if (state === "denied") {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled
        title="Browser permission was denied. Re-enable in site settings."
        className="h-8 px-2 text-muted-foreground"
      >
        <BellOff className="h-4 w-4" />
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={isOn ? turnOff : turnOn}
      disabled={busy || vapid.isLoading}
      title={
        error
          ? `Push error: ${error}`
          : isOn
            ? "Browser alerts ON — click to disable"
            : "Enable browser alerts for new BUY/SELL signals"
      }
      className={`h-8 px-2 ${
        isOn ? "text-emerald-400 hover:text-emerald-300" : "text-muted-foreground"
      }`}
    >
      {isOn ? <BellRing className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
      <span className="hidden md:inline ml-1.5 text-[11px] tracking-wide">
        {busy ? "…" : isOn ? "ALERTS" : "ALERTS"}
      </span>
    </Button>
  );
}
