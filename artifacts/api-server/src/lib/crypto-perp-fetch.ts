import type { CandleRaw } from "./yahoo-fetch";

// OKX USDT-margined perpetual swaps. Public endpoints, no auth required.
// Binance and Bybit geo-block US-based servers (Replit), OKX does not.
// OKX is the third-largest perp venue with deep BTC/ETH liquidity, so the
// price discovery is faithful to what most traders see.

const BASE = "https://www.okx.com/api/v5";

type OkxBar = "1H" | "4H" | "1D" | "1W";

interface PerpConfig {
  bar: OkxBar;
  // Total target bars to assemble from /market/candles (latest 300) plus
  // any number of /market/history-candles pages (100/page).
  targetBars: number;
  isIntraday: boolean;
}

// Intraday timeframes: enough bars for ~weeks of context. Daily: ~4 years.
// 1H gets a deeper sample so backtest stats stay meaningful.
const PERP_TIMEFRAME_MAP: Record<string, PerpConfig> = {
  "1h": { bar: "1H", targetBars: 2500, isIntraday: true  },
  "4h": { bar: "4H", targetBars: 1500, isIntraday: true  },
  "1d": { bar: "1D", targetBars: 1500, isIntraday: false },
  "1w": { bar: "1W", targetBars: 500,  isIntraday: false },
};

// OKX endpoint limits: /candles up to 300, /history-candles up to 100.
const LATEST_LIMIT = 300;
const HISTORY_LIMIT = 100;

interface OkxResponse {
  code: string;
  msg: string;
  // [openTime(ms,str), open, high, low, close, volume, volCcy, volCcyQuote, confirm]
  data: string[][];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── OKX concurrency limiter ──────────────────────────────────────────────────
// OKX rate-limits by IP. Firing 48+ parallel candle fetches causes 429 bursts.
// This semaphore caps concurrent fetchOkxPerpCandles calls to 5 at a time so
// the full notifier poll completes without triggering rate limits.
const MAX_OKX_CONCURRENT = 5;
let okxSlotsTaken = 0;
const okxWaiters: Array<() => void> = [];

function acquireOkxSlot(): Promise<void> {
  if (okxSlotsTaken < MAX_OKX_CONCURRENT) {
    okxSlotsTaken++;
    return Promise.resolve();
  }
  return new Promise((resolve) => okxWaiters.push(resolve));
}

function releaseOkxSlot(): void {
  const next = okxWaiters.shift();
  if (next) {
    next();
  } else {
    okxSlotsTaken--;
  }
}

// OKX rate limits are per-IP per-2s window. On 429 (or 5xx) back off and retry
// a few times so a transient burst doesn't surface as a user-visible 500.
async function okxGet(path: string): Promise<string[][]> {
  const maxAttempts = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(`${BASE}${path}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)",
        },
        signal: AbortSignal.timeout(8000),
      });
      if (response.status === 429 || response.status >= 500) {
        lastErr = new Error(`OKX request failed: ${response.status}`);
        // 600ms, 1.2s, 2.4s — covers the 2s OKX window comfortably.
        await sleep(600 * Math.pow(2, attempt - 1));
        continue;
      }
      if (!response.ok) {
        throw new Error(`OKX request failed: ${response.status}`);
      }
      const json = (await response.json()) as OkxResponse;
      if (json.code !== "0") {
        throw new Error(`OKX error ${json.code}: ${json.msg}`);
      }
      return json.data;
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      await sleep(600 * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("OKX request failed");
}

export async function fetchOkxPerpCandles(
  instId: string,
  timeframe: string,
): Promise<CandleRaw[]> {
  await acquireOkxSlot();
  try {
    return await _fetchOkxPerpCandles(instId, timeframe);
  } finally {
    releaseOkxSlot();
  }
}

/**
 * Fetches only the most recent N candles for a symbol+timeframe.
 * Much faster than fetchOkxPerpCandles for one-off computations (e.g.
 * BB30 midline lookup) because it never paginates history.
 * Returns candles ascending (oldest first), live candle included at the end.
 */
export async function fetchOkxPerpCandlesRecent(
  instId: string,
  timeframe: string,
  limit = 50,
): Promise<CandleRaw[]> {
  const cfg = PERP_TIMEFRAME_MAP[timeframe];
  if (!cfg) throw new Error(`Unsupported perp timeframe: ${timeframe}`);
  const rows = await okxGet(
    `/market/candles?instId=${encodeURIComponent(instId)}&bar=${cfg.bar}&limit=${Math.min(limit, 300)}`,
  );
  // OKX returns newest-first — reverse to ascending, convert.
  return rows
    .slice()
    .reverse()
    .map((row) => {
      const ts = Number(row[0]);
      const iso = new Date(ts).toISOString();
      return {
        date:   cfg.isIntraday ? iso : iso.split("T")[0],
        open:   parseFloat(row[1]),
        high:   parseFloat(row[2]),
        low:    parseFloat(row[3]),
        close:  parseFloat(row[4]),
        volume: parseFloat(row[5] ?? "0"),
      };
    })
    .filter((c) => isFinite(c.open) && isFinite(c.close));
}

async function _fetchOkxPerpCandles(
  instId: string,
  timeframe: string,
): Promise<CandleRaw[]> {
  const cfg = PERP_TIMEFRAME_MAP[timeframe];
  if (!cfg) throw new Error(`Unsupported perp timeframe: ${timeframe}`);

  // Step 1: latest 300 (or fewer if target is smaller).
  const latest = await okxGet(
    `/market/candles?instId=${encodeURIComponent(instId)}&bar=${cfg.bar}&limit=${Math.min(
      LATEST_LIMIT,
      cfg.targetBars,
    )}`,
  );
  // OKX returns newest-first. Track the oldest timestamp seen so we can page back.
  const collected: string[][] = latest.slice();
  let oldestTs =
    collected.length > 0
      ? Number(collected[collected.length - 1][0])
      : Date.now();

  // Step 2: paginate history-candles backwards until we hit targetBars or
  // the API stops returning data.
  let safety = 30; // hard cap on history pages
  while (collected.length < cfg.targetBars && safety > 0) {
    const remaining = cfg.targetBars - collected.length;
    const limit = Math.min(HISTORY_LIMIT, remaining);
    const page = await okxGet(
      `/market/history-candles?instId=${encodeURIComponent(instId)}&bar=${cfg.bar}&limit=${limit}&after=${oldestTs}`,
    );
    if (page.length === 0) break;
    collected.push(...page);
    oldestTs = Number(page[page.length - 1][0]);
    if (page.length < limit) break;
    safety--;
    // Pace pagination to stay under OKX's 20 req / 2s history-candles window.
    await sleep(120);
  }

  // Convert + dedupe by openTime + sort ascending.
  const byTime = new Map<number, CandleRaw>();
  for (const row of collected) {
    const ts = Number(row[0]);
    const o = parseFloat(row[1]);
    const h = parseFloat(row[2]);
    const l = parseFloat(row[3]);
    const c = parseFloat(row[4]);
    const v = parseFloat(row[5]);
    if (!isFinite(ts) || ![o, h, l, c].every((n) => isFinite(n))) continue;
    const iso = new Date(ts).toISOString();
    byTime.set(ts, {
      date: cfg.isIntraday ? iso : iso.split("T")[0],
      open: o,
      high: h,
      low: l,
      close: c,
      volume: isFinite(v) ? v : 0,
    });
  }
  return Array.from(byTime.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => c);
}

export async function fetchOkxPerpPrice(
  instId: string,
): Promise<number | null> {
  try {
    const data = await okxGet(
      `/market/ticker?instId=${encodeURIComponent(instId)}`,
    );
    // /market/ticker returns objects, not arrays — re-parse as any to read `last`.
    const arr = data as unknown as Array<{ last?: string }>;
    const last = arr[0]?.last;
    if (typeof last !== "string") return null;
    const price = parseFloat(last);
    return isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

// Phemex USDT-margined perp mark price. We pick `markRp` (mark, not last)
// because the mark is the same number TradingView's PHEMEX:BTCUSDT chart
// displays in the price scale and the same number Phemex uses for liq /
// funding — keeps the Now-price line and the chart in lockstep, even when
// the order-book last drifts a few ticks. v3 endpoint returns "real" prices
// (Rp suffix) — no integer scaling needed.
interface PhemexTickerResponse {
  error: unknown;
  id: number;
  result?: {
    symbol?: string;
    markRp?: string;
    lastRp?: string;
  };
}

export async function fetchPhemexPerpPrice(
  symbol: string,
): Promise<number | null> {
  try {
    const response = await fetch(
      `https://api.phemex.com/md/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)",
        },
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!response.ok) return null;
    const json = (await response.json()) as PhemexTickerResponse;
    if (json.error) return null;
    // Prefer mark (matches TradingView's PHEMEX:BTCUSDT print). Fall back to
    // last if mark is missing — the two are within a tick on liquid pairs.
    const raw = json.result?.markRp ?? json.result?.lastRp;
    if (typeof raw !== "string") return null;
    const price = parseFloat(raw);
    return isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}
