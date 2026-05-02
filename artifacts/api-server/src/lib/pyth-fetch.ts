// Pyth Hermes (https://hermes.pyth.network) — the same oracle feed Jupiter
// reads on-chain to mark perps, compute funding, and trigger liquidations.
// Using this for spot keeps the Now-price line and the BTC/ETH chart in
// lockstep with what the trader actually sees on jup.ag.
//
// Public endpoint, no auth. Mainnet feed IDs are stable, documented at
// https://www.pyth.network/developers/price-feed-ids.

const HERMES_BASE = "https://hermes.pyth.network";

interface HermesParsedPrice {
  id: string;
  price: {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
  };
  ema_price?: unknown;
  metadata?: unknown;
}

interface HermesLatestResponse {
  binary: unknown;
  parsed: HermesParsedPrice[];
}

export async function fetchPythPrice(feedId: string): Promise<number | null> {
  try {
    // Hermes accepts feed IDs with or without a leading "0x". Stripping keeps
    // URLs short and matches the canonical hex form returned in `parsed[].id`.
    const id = feedId.startsWith("0x") ? feedId.slice(2) : feedId;
    const response = await fetch(
      `${HERMES_BASE}/v2/updates/price/latest?ids[]=${id}&parsed=true&encoding=hex`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)",
        },
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!response.ok) return null;
    const json = (await response.json()) as HermesLatestResponse;
    const entry = json.parsed?.[0];
    if (!entry?.price) return null;
    const raw = Number(entry.price.price);
    const expo = Number(entry.price.expo);
    if (!isFinite(raw) || !isFinite(expo)) return null;
    const price = raw * Math.pow(10, expo);
    return isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}
