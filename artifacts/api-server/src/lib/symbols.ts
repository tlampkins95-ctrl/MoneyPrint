export type Symbol =
  | "XAGUSD"
  | "XAUUSD"
  | "EURUSD"
  | "GBPUSD"
  | "AUDUSD"
  | "BTCUSD"
  | "ETHUSD"
  | "SKYAIUSDT"
  | "ZECUSD";

export interface SymbolMeta {
  yahoo: string;
  tvSymbol: string;
  tvScrapePath: string;
  label: string;
  decimals: number;
  prefix: string;
  category: "forex" | "crypto";
  goldApi?: "XAG" | "XAU";
  // True for symbols whose Yahoo candle data comes from a futures contract
  // (SI=F for silver, GC=F for gold). A basis shift is applied at response
  // time to align OHLCV candles with broker spot prices (MT5 / OANDA).
  hasFuturesBasis?: boolean;
  coinbase?: string;
  okxPerp?: string;
  // Phemex USDT-margined perp symbol (e.g. "BTCUSDT"). When present, Phemex
  // is the primary spot source so the Now-price line agrees with the
  // PHEMEX:BTCUSDT chart's mark print.
  phemexPerp?: string;
  // Phemex contract minimum order qty in coin units. BTCUSDT trades in
  // 0.001 BTC contracts, ETHUSDT in 0.01 ETH. The exchange rejects any
  // order below `phemexMinQty`, so the screener forces over-sized when the
  // ideal position is below this floor (notional ≈ minQty × entry).
  phemexMinQty?: number;
  // Phemex contract qty increment. Orders are rounded DOWN to this step
  // (you can't place 0.0017 BTC, only 0.001 or 0.002).
  phemexQtyStep?: number;
  // Phemex SPOT symbol (prefixed with lowercase 's', e.g. "sSKYAIUSDT").
  // When present, the live price is fetched from Phemex's spot ticker so the
  // Now-price line in the screener agrees with the PHEMEX spot chart to the cent.
  phemexSpot?: string;
  // Price scale for the Phemex spot ticker Ep fields (10^priceScale divides Ep).
  // Phemex returns lastEp as an integer; divide by 10^phemexSpotPriceScale for USD.
  phemexSpotPriceScale?: number;
  // Pyth Hermes price-feed IDs (mainnet). Used as the primary spot source for
  // crypto so the Now-price line agrees with jup.ag's chart and oracle marks.
  pythFeedId?: string;
  // Gate.io spot currency pair (e.g. "SKYAI_USDT"). Used as the candle source
  // for tokens not listed on OKX or Yahoo Finance.
  gateioSpot?: string;
  venue?: string;
  // When true, only BUY signals are generated. SELL signals are suppressed
  // because the exchange only supports spot (no shorting).
  longOnly?: boolean;
}

export const SYMBOLS: Record<Symbol, SymbolMeta> = {
  XAGUSD: {
    yahoo: "SI=F",
    tvSymbol: "OANDA:XAGUSD",
    tvScrapePath: "/symbols/XAGUSD/?exchange=OANDA",
    label: "Silver / USD",
    decimals: 3,
    prefix: "$",
    category: "forex",
    goldApi: "XAG",
    hasFuturesBasis: true,
  },
  XAUUSD: {
    yahoo: "GC=F",
    tvSymbol: "OANDA:XAUUSD",
    tvScrapePath: "/symbols/XAUUSD/?exchange=OANDA",
    label: "Gold / USD",
    decimals: 2,
    prefix: "$",
    category: "forex",
    goldApi: "XAU",
    hasFuturesBasis: true,
  },
  EURUSD: {
    yahoo: "EURUSD=X",
    tvSymbol: "OANDA:EURUSD",
    tvScrapePath: "/symbols/EURUSD/?exchange=OANDA",
    label: "EUR / USD",
    decimals: 5,
    prefix: "",
    category: "forex",
  },
  GBPUSD: {
    yahoo: "GBPUSD=X",
    tvSymbol: "OANDA:GBPUSD",
    tvScrapePath: "/symbols/GBPUSD/?exchange=OANDA",
    label: "GBP / USD",
    decimals: 5,
    prefix: "",
    category: "forex",
  },
  AUDUSD: {
    yahoo: "AUDUSD=X",
    tvSymbol: "OANDA:AUDUSD",
    tvScrapePath: "/symbols/AUDUSD/?exchange=OANDA",
    label: "AUD / USD",
    decimals: 5,
    prefix: "",
    category: "forex",
  },
  BTCUSD: {
    yahoo: "BTC-USD",
    // Chart now points at Phemex's USDT-margined perp (BTCUSDT). The label
    // still says "BTCUSD" to keep URLs and saved bookmarks stable, but the
    // tvSymbol/tvScrapePath and the position-sizing block are Phemex's.
    tvSymbol: "PHEMEX:BTCUSDT",
    tvScrapePath: "/symbols/BTCUSDT/?exchange=PHEMEX",
    label: "Bitcoin / USDT (Phemex)",
    decimals: 1,
    prefix: "$",
    category: "crypto",
    coinbase: "BTC-USD",
    okxPerp: "BTC-USDT-SWAP",
    phemexPerp: "BTCUSDT",
    phemexMinQty: 0.001,
    phemexQtyStep: 0.001,
    pythFeedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    venue: "PHEMEX · USDT perp",
  },
  ETHUSD: {
    yahoo: "ETH-USD",
    tvSymbol: "PHEMEX:ETHUSDT",
    tvScrapePath: "/symbols/ETHUSDT/?exchange=PHEMEX",
    label: "Ethereum / USDT (Phemex)",
    decimals: 2,
    prefix: "$",
    category: "crypto",
    coinbase: "ETH-USD",
    okxPerp: "ETH-USDT-SWAP",
    phemexPerp: "ETHUSDT",
    phemexMinQty: 0.01,
    phemexQtyStep: 0.01,
    pythFeedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    venue: "PHEMEX · USDT perp",
  },
  SKYAIUSDT: {
    yahoo: "SKYAI-USD",
    tvSymbol: "PHEMEX:SKYAIUSDT",
    tvScrapePath: "/symbols/SKYAIUSDT/?exchange=PHEMEX",
    label: "SKYAI / USDT (Phemex spot)",
    decimals: 4,
    prefix: "$",
    category: "crypto",
    coinbase: "SKYAI-USD",
    phemexSpot: "sSKYAIUSDT",
    phemexSpotPriceScale: 8,
    gateioSpot: "SKYAI_USDT",
    venue: "Phemex · spot",
    longOnly: true,
  },
  ZECUSD: {
    yahoo: "ZEC-USD",
    tvSymbol: "PHEMEX:ZECUSDT",
    tvScrapePath: "/symbols/ZECUSDT/?exchange=PHEMEX",
    label: "Zcash / USDT (Phemex)",
    decimals: 2,
    prefix: "$",
    category: "crypto",
    coinbase: "ZEC-USD",
    okxPerp: "ZEC-USDT-SWAP",
    phemexPerp: "ZECUSDT",
    phemexMinQty: 0.01,
    phemexQtyStep: 0.01,
    venue: "PHEMEX · USDT perp",
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
