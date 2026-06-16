export type Symbol =
  | "XAGUSD"
  | "XAUUSD"
  | "EURUSD"
  | "GBPUSD"
  | "AUDUSD"
  | "BTCUSD"
  | "ETHUSD"
  | "SOLUSD"
  | "USDCHF"
  | "ZECUSD";

export interface SymbolMeta {
  tv: string;
  short: string;
  long: string;
  badge: string;
  decimals: number;
  prefix: string;
  category: "forex" | "crypto";
  venue?: string;
  // When true, only BUY signals are generated (spot-only instrument, no shorting).
  longOnly?: boolean;
}

export const SYMBOLS: Record<Symbol, SymbolMeta> = {
  XAGUSD:    { tv: "OANDA:XAGUSD",      short: "XAG/USD",  long: "Silver",           badge: "Ag", decimals: 3, prefix: "$", category: "forex" },
  XAUUSD:    { tv: "OANDA:XAUUSD",      short: "XAU/USD",  long: "Gold",             badge: "Au", decimals: 2, prefix: "$", category: "forex" },
  EURUSD:    { tv: "OANDA:EURUSD",      short: "EUR/USD",  long: "Euro",             badge: "€",  decimals: 5, prefix: "",  category: "forex" },
  GBPUSD:    { tv: "OANDA:GBPUSD",      short: "GBP/USD",  long: "Cable",            badge: "£",  decimals: 5, prefix: "",  category: "forex" },
  AUDUSD:    { tv: "OANDA:AUDUSD",      short: "AUD/USD",  long: "Aussie",           badge: "AU", decimals: 5, prefix: "",  category: "forex" },
  BTCUSD:    { tv: "OKX:BTCUSDT.P",    short: "BTC/USDT", long: "Bitcoin (OKX Perp)",  badge: "₿",  decimals: 1, prefix: "$", category: "crypto", venue: "OKX · USDT perp" },
  ETHUSD:    { tv: "OKX:ETHUSDT.P",    short: "ETH/USDT", long: "Ethereum (OKX Perp)", badge: "Ξ",  decimals: 2, prefix: "$", category: "crypto", venue: "OKX · USDT perp" },
  SOLUSD:    { tv: "OKX:SOLUSDT.P",    short: "SOL/USDT", long: "Solana (OKX Perp)",   badge: "◎",  decimals: 2, prefix: "$", category: "crypto", venue: "OKX · USDT perp" },
  USDCHF:    { tv: "OANDA:USDCHF",      short: "USD/CHF",  long: "Swissie",              badge: "Fr", decimals: 5, prefix: "",  category: "forex" },
  ZECUSD:    { tv: "OKX:ZECUSDT.P",    short: "ZEC/USDT", long: "Zcash (OKX Perp)",    badge: "ZE", decimals: 2, prefix: "$", category: "crypto", venue: "OKX · USDT perp" },
};

export const ALL_SYMBOLS: Symbol[] = Object.keys(SYMBOLS) as Symbol[];
export const FOREX_SYMBOLS:  Symbol[] = ALL_SYMBOLS.filter((s) => SYMBOLS[s].category === "forex");
export const CRYPTO_SYMBOLS: Symbol[] = ALL_SYMBOLS.filter((s) => SYMBOLS[s].category === "crypto");

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
    category: "crypto" as const,
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
