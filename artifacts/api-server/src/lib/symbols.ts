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
  yahoo: string;
  tvSymbol: string;
  tvScrapePath: string;
  label: string;
  decimals: number;
  prefix: string;
  goldApi?: "XAG" | "XAU";
  coinbase?: string;
  okxPerp?: string;
  // Pyth Hermes price-feed IDs (mainnet). Used as the primary spot source for
  // crypto so the Now-price line agrees with jup.ag's chart and oracle marks.
  pythFeedId?: string;
  venue?: string;
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
    tvSymbol: "PYTH:BTCUSD",
    tvScrapePath: "/symbols/BTCUSD/?exchange=PYTH",
    label: "Bitcoin / USD (Pyth)",
    decimals: 1,
    prefix: "$",
    coinbase: "BTC-USD",
    okxPerp: "BTC-USDT-SWAP",
    pythFeedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    venue: "PYTH · jup.ag",
  },
  ETHUSD: {
    yahoo: "ETH-USD",
    tvSymbol: "PYTH:ETHUSD",
    tvScrapePath: "/symbols/ETHUSD/?exchange=PYTH",
    label: "Ethereum / USD (Pyth)",
    decimals: 2,
    prefix: "$",
    coinbase: "ETH-USD",
    okxPerp: "ETH-USDT-SWAP",
    pythFeedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    venue: "PYTH · jup.ag",
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
