// Static, version-controlled mirror of the user's TradingView "Trades"
// watchlist (30 symbols). TradingView has no clean public API for personal
// watchlists and the watchlist page is JS-rendered (fragile/ToS-risk to
// scrape), so this list is hardcoded and updated manually if the TradingView
// watchlist changes — per the finalized harmonic-pattern spec.
//
// NOTE on BEATUSDT: present in the TradingView watchlist without a `.P`
// (perp) suffix. Phemex only lists BEAT as a spot pair, not a perp, and this
// pattern engine trades perps via the existing Phemex perp infrastructure —
// so BEATUSDT is deliberately excluded here rather than silently dropped
// elsewhere. If/when the system supports spot execution, BEATUSDT would need
// its own spot-specific routing (out of scope for this build).
export const TRADINGVIEW_WATCHLIST: string[] = [
  "VVVUSDT", "LITUSDT", "LDOUSDT", "HYPEUSDT", "DASHUSDT", "SOLUSDT",
  "ETHUSDT", "XLMUSDT", "DYDXUSDT", "SYRUPUSDT", "SUIUSDT", "BTCUSDT",
  "WLDUSDT", "TAOUSDT", "ARBUSDT", "GRASSUSDT", "METUSDT", "ONDOUSDT",
  "NEARUSDT", "ZROUSDT", "AAVEUSDT", "CHIPUSDT", "XPLUSDT", "VIRTUALUSDT",
  "REUSDT", "ZECUSDT", "PYTHUSDT", "UNIUSDT", "ALLOUSDT",
];

export function watchlistToOkxInstId(ticker: string): string {
  const base = ticker.endsWith("USDT") ? ticker.slice(0, -4) : ticker;
  return `${base}-USDT-SWAP`;
}

export function watchlistToPhemexSymbol(ticker: string): string {
  return ticker; // already in Phemex's TICKERUSDT format
}
