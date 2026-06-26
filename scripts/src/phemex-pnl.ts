import { createHmac } from "crypto";

const LIVE_URL = "https://api.phemex.com";

function sign(secret: string, path: string, rawQuery: string, expiry: number): string {
  const msg = path + rawQuery + expiry.toString();
  return createHmac("sha256", secret).update(msg).digest("hex");
}

async function phemexGet<T>(path: string, query: Record<string, string> = {}): Promise<T> {
  const apiKey    = process.env["PHEMEX_API_KEY"]!;
  const apiSecret = process.env["PHEMEX_API_SECRET"]!;
  const expiry    = Math.floor(Date.now() / 1000) + 60;
  const rawQuery  = new URLSearchParams(query).toString();
  const sig       = sign(apiSecret, path, rawQuery, expiry);
  const url       = `${LIVE_URL}${path}${rawQuery ? "?" + rawQuery : ""}`;
  const res = await fetch(url, {
    headers: {
      "x-phemex-access-token":      apiKey,
      "x-phemex-request-expiry":    expiry.toString(),
      "x-phemex-request-signature": sig,
    },
  });
  return res.json() as Promise<T>;
}

interface TradeRow {
  symbol:        string;
  side:          string;
  execQty:       string;
  execPriceRp:   string;
  execValueRv:   string;
  feeRateRr:     string;
  execFeeRv:     string;
  closedPnlRv:   string;
  ordType:       string;
  execType:      string;
  tradeType:     string;
  transactTimeNs: string;
}

interface TradesResp {
  code: number;
  msg:  string;
  data: { rows: TradeRow[] };
}

async function fetchPnlBySymbol(symbol: string): Promise<{ symbol: string; pnl: number; trades: number }> {
  const resp = await phemexGet<TradesResp>("/api-data/g-futures/trades", {
    symbol,
    limit: "200",
  });
  if (resp.code !== 0 || !resp.data?.rows) {
    return { symbol, pnl: 0, trades: 0 };
  }
  const closingTrades = resp.data.rows.filter(r => parseFloat(r.closedPnlRv) !== 0);
  const totalPnl = closingTrades.reduce((sum, r) => sum + parseFloat(r.closedPnlRv), 0);
  return { symbol, pnl: totalPnl, trades: closingTrades.length };
}

// Get all positions to find which symbols were traded
interface PositionRow {
  symbol:    string;
  side:      string;
  size:      string;
  avgEntryPriceRp: string;
  unrealisedPnlRv: string;
}
interface AccountResp {
  code: number;
  data: { positions: PositionRow[] };
}

async function main() {
  // 1. Get current positions to know which symbols are/were active
  const account = await phemexGet<AccountResp>("/g-accounts/accountPositions", { currency: "USDT" });
  if (account.code !== 0) {
    console.error("Failed to fetch positions:", account);
    process.exit(1);
  }

  const activeSymbols = account.data.positions
    .filter(p => parseFloat(p.size) !== 0)
    .map(p => p.symbol);

  console.log("Active positions:", activeSymbols.join(", ") || "none");

  // 2. Fetch P&L for a fixed list of symbols that have been traded
  // (Phemex doesn't have a "all closed P&L" endpoint; must query per symbol)
  const toCheck = [
    ...new Set([
      ...activeSymbols,
      // Trending coins known to have been traded:
      "PENGUUSDT", "ONDOUSDT", "HYPEUSDT", "AVAXUSDT",
      "SOLUSDT", "LITUSDT", "MORPHOUSDT", "DOTUSDT",
      "SUSDT", "PUMPUSDT", "SOPHUSDT", "QNTUSDT",
      "ASTERUSDT", "AXSUSDT", "VIRTUALUSDT", "METUSDT",
      "POLUSDT", "JTOUSDT", "ZECUSD", "SOLUSD",
    ]),
  ];

  const results = await Promise.all(toCheck.map(fetchPnlBySymbol));

  // Sort by absolute P&L descending
  results.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));

  console.log("\nReal Phemex closed P&L (last 200 fills per symbol):");
  console.log("Symbol".padEnd(18), "Trades".padEnd(8), "Closed PnL (USDT)");
  console.log("-".repeat(44));
  let grandTotal = 0;
  for (const r of results) {
    if (r.trades > 0 || r.pnl !== 0) {
      const sign = r.pnl >= 0 ? "+" : "";
      console.log(r.symbol.padEnd(18), String(r.trades).padEnd(8), `${sign}${r.pnl.toFixed(4)}`);
      grandTotal += r.pnl;
    }
  }
  console.log("-".repeat(44));
  const gtSign = grandTotal >= 0 ? "+" : "";
  console.log("TOTAL".padEnd(26), `${gtSign}${grandTotal.toFixed(4)} USDT`);
}

main().catch(console.error);
