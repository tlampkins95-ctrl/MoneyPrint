export type Symbol =
  | "XAGUSD"
  | "XAUUSD"
  | "EURUSD"
  | "GBPUSD"
  | "AUDUSD"
  | "USDJPY"
  | "GBPJPY"
  | "BTCUSD";

export interface SymbolMeta {
  yahoo: string;
  tvSymbol: string;
  tvScrapePath: string;
  label: string;
  decimals: number;
  prefix: string;
  goldApi?: "XAG" | "XAU";
}

export const SYMBOLS: Record<Symbol, SymbolMeta> = {
  XAGUSD: {
    yahoo: "SI=F",
    tvSymbol: "OANDA:XAGUSD",
    tvScrapePath: "/symbols/XAGUSD/?exchange=OANDA",
    label: "Silver / USD",
    decimals: 3,
    prefix: "$",
    goldApi: "XAG",
  },
  XAUUSD: {
    yahoo: "GC=F",
    tvSymbol: "OANDA:XAUUSD",
    tvScrapePath: "/symbols/XAUUSD/?exchange=OANDA",
    label: "Gold / USD",
    decimals: 2,
    prefix: "$",
    goldApi: "XAU",
  },
  EURUSD: {
    yahoo: "EURUSD=X",
    tvSymbol: "OANDA:EURUSD",
    tvScrapePath: "/symbols/EURUSD/?exchange=OANDA",
    label: "EUR / USD",
    decimals: 5,
    prefix: "",
  },
  GBPUSD: {
    yahoo: "GBPUSD=X",
    tvSymbol: "OANDA:GBPUSD",
    tvScrapePath: "/symbols/GBPUSD/?exchange=OANDA",
    label: "GBP / USD",
    decimals: 5,
    prefix: "",
  },
  AUDUSD: {
    yahoo: "AUDUSD=X",
    tvSymbol: "OANDA:AUDUSD",
    tvScrapePath: "/symbols/AUDUSD/?exchange=OANDA",
    label: "AUD / USD",
    decimals: 5,
    prefix: "",
  },
  USDJPY: {
    yahoo: "JPY=X",
    tvSymbol: "OANDA:USDJPY",
    tvScrapePath: "/symbols/USDJPY/?exchange=OANDA",
    label: "USD / JPY",
    decimals: 3,
    prefix: "",
  },
  GBPJPY: {
    yahoo: "GBPJPY=X",
    tvSymbol: "OANDA:GBPJPY",
    tvScrapePath: "/symbols/GBPJPY/?exchange=OANDA",
    label: "GBP / JPY",
    decimals: 3,
    prefix: "",
  },
  BTCUSD: {
    yahoo: "BTC-USD",
    tvSymbol: "BITSTAMP:BTCUSD",
    tvScrapePath: "/symbols/BTCUSD/?exchange=BITSTAMP",
    label: "Bitcoin / USD",
    decimals: 1,
    prefix: "$",
  },
};

export const ALL_SYMBOLS: Symbol[] = Object.keys(SYMBOLS) as Symbol[];

export function isSymbol(v: unknown): v is Symbol {
  return typeof v === "string" && v in SYMBOLS;
}

export function makeRounder(decimals: number) {
  const factor = Math.pow(10, decimals);
  return (n: number) => Math.round(n * factor) / factor;
}
