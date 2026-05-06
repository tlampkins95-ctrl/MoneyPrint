export type Symbol =
  | "XAGUSD"
  | "XAUUSD"
  | "EURUSD"
  | "GBPUSD"
  | "AUDUSD"
  | "USDJPY"
  | "GBPJPY"
  | "BTCUSD"
  | "ETHUSD"
  | "SKYAIUSDT"
  | "ZECUSD";

export interface SymbolMeta {
  tv: string;
  short: string;
  long: string;
  badge: string;
  decimals: number;
  prefix: string;
  venue?: string;
}

export const SYMBOLS: Record<Symbol, SymbolMeta> = {
  XAGUSD: { tv: "OANDA:XAGUSD",     short: "XAG/USD",  long: "Silver",   badge: "Ag",   decimals: 3, prefix: "$" },
  XAUUSD: { tv: "OANDA:XAUUSD",     short: "XAU/USD",  long: "Gold",     badge: "Au",   decimals: 2, prefix: "$" },
  EURUSD: { tv: "OANDA:EURUSD",     short: "EUR/USD",  long: "Euro",     badge: "EU",   decimals: 5, prefix: "" },
  GBPUSD: { tv: "OANDA:GBPUSD",     short: "GBP/USD",  long: "Cable",    badge: "GB",   decimals: 5, prefix: "" },
  AUDUSD: { tv: "OANDA:AUDUSD",     short: "AUD/USD",  long: "Aussie",   badge: "AU",   decimals: 5, prefix: "" },
  USDJPY: { tv: "OANDA:USDJPY",     short: "USD/JPY",  long: "Yen",      badge: "¥",    decimals: 3, prefix: "" },
  GBPJPY: { tv: "OANDA:GBPJPY",     short: "GBP/JPY",  long: "Beast",    badge: "G¥",   decimals: 3, prefix: "" },
  BTCUSD: { tv: "PHEMEX:BTCUSDT", short: "BTC/USD", long: "Bitcoin (Phemex)",  badge: "₿", decimals: 1, prefix: "$", venue: "PHEMEX · USDT perp" },
  ETHUSD: { tv: "PHEMEX:ETHUSDT", short: "ETH/USD", long: "Ethereum (Phemex)", badge: "Ξ", decimals: 2, prefix: "$", venue: "PHEMEX · USDT perp" },
  SKYAIUSDT: { tv: "PHEMEX:SKYAIUSDT", short: "SKY/USDT", long: "SKYAI (Phemex spot)", badge: "SK", decimals: 4, prefix: "$", venue: "Phemex · spot" },
  ZECUSD:    { tv: "PHEMEX:ZECUSDT",   short: "ZEC/USD",  long: "Zcash (Phemex)",      badge: "ZE", decimals: 2, prefix: "$", venue: "PHEMEX · USDT perp" },
};

export const ALL_SYMBOLS: Symbol[] = Object.keys(SYMBOLS) as Symbol[];

export function fmtPrice(symbol: Symbol, n: number): string {
  const m = SYMBOLS[symbol];
  return `${m.prefix}${n.toFixed(m.decimals)}`;
}

export function fmtPriceCompact(symbol: Symbol, n: number, dropDecimals = 0): string {
  const m = SYMBOLS[symbol];
  const d = Math.max(0, m.decimals - dropDecimals);
  return `${m.prefix}${n.toFixed(d)}`;
}

// Returns SymbolMeta for any symbol key — static or dynamic trending coin.
export function getSymbolMeta(key: string): SymbolMeta {
  if (key in SYMBOLS) return SYMBOLS[key as Symbol];
  const base = key.replace(/USDT?$/, "");
  return {
    tv: `OKX:${key}.P`,
    short: `${base}/USDT`,
    long: `${base} (Trending)`,
    badge: base.slice(0, 2).toUpperCase(),
    decimals: 4,
    prefix: "$",
    venue: "PHEMEX · USDT perp",
  };
}

export function fmtPriceMeta(meta: SymbolMeta, n: number): string {
  return `${meta.prefix}${n.toFixed(meta.decimals)}`;
}

export function fmtPriceCompactMeta(meta: SymbolMeta, n: number, dropDecimals = 0): string {
  const d = Math.max(0, meta.decimals - dropDecimals);
  return `${meta.prefix}${n.toFixed(d)}`;
}
