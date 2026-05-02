export type Symbol =
  | "XAGUSD"
  | "XAUUSD"
  | "EURUSD"
  | "GBPUSD"
  | "AUDUSD"
  | "USDJPY"
  | "GBPJPY"
  | "BTCUSD"
  | "ETHUSD";

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
  BTCUSD: { tv: "OKX:BTCUSDT.P", short: "BTC/USDT.P", long: "Bitcoin Perp",  badge: "₿", decimals: 1, prefix: "$", venue: "OKX PERP" },
  ETHUSD: { tv: "OKX:ETHUSDT.P", short: "ETH/USDT.P", long: "Ethereum Perp", badge: "Ξ", decimals: 2, prefix: "$", venue: "OKX PERP" },
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
