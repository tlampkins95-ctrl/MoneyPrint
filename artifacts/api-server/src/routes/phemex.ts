import { Router, type IRouter, type Request, type Response } from "express";
import {
  getUSDTBalance, isPhemexTradingEnabled,
  cancelExistingTpOrders, placeLimitClose, checkExistingPosition,
} from "../lib/phemex-trader";
import {
  setPhemexAutoTraderEnabled, getPhemexAutoTraderEnabled,
  setProfitLockEnabled, setProfitLockThreshold, getProfitLockState,
} from "../lib/notifier";
import { getAllActiveTradeSymbols, getActiveTrade, calcBollingerBands } from "../lib/signals";
import { fetchOkxPerpCandlesRecent } from "../lib/crypto-perp-fetch";

const router: IRouter = Router();

router.get("/phemex/ping", async (req: Request, res: Response) => {
  if (!isPhemexTradingEnabled()) {
    res.status(503).json({ ok: false, error: "PHEMEX_API_KEY / PHEMEX_API_SECRET not set" });
    return;
  }
  const balance = await getUSDTBalance();
  if (balance === null) {
    res.status(502).json({ ok: false, error: "Could not fetch balance — check key permissions or IP whitelist" });
    return;
  }
  res.json({ ok: true, usdtBalance: balance, testnet: process.env["PHEMEX_TESTNET"] === "true" });
});

router.get("/phemex/status", async (req: Request, res: Response) => {
  const keysPresent = isPhemexTradingEnabled();
  const enabled = getPhemexAutoTraderEnabled();
  const balance = keysPresent ? await getUSDTBalance() : null;
  res.json({
    keysPresent,
    enabled,
    usdtBalance: balance,
    testnet: process.env["PHEMEX_TESTNET"] === "true",
  });
});

router.post("/phemex/toggle", (req: Request, res: Response) => {
  if (!isPhemexTradingEnabled()) {
    res.status(503).json({ ok: false, error: "API keys not configured" });
    return;
  }
  const body = req.body as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") {
    res.status(400).json({ ok: false, error: "Body must be { enabled: boolean }" });
    return;
  }
  setPhemexAutoTraderEnabled(body.enabled);
  res.json({ ok: true, enabled: body.enabled });
});

router.get("/phemex/profit-lock", (req: Request, res: Response) => {
  res.json(getProfitLockState());
});

router.post("/phemex/profit-lock", (req: Request, res: Response) => {
  if (!isPhemexTradingEnabled()) {
    res.status(503).json({ ok: false, error: "API keys not configured" });
    return;
  }
  const body = req.body as { enabled?: boolean; threshold?: number };
  if (typeof body.enabled !== "boolean" && typeof body.threshold !== "number") {
    res.status(400).json({ ok: false, error: "Body must include { enabled?: boolean, threshold?: number }" });
    return;
  }
  if (typeof body.enabled === "boolean") setProfitLockEnabled(body.enabled);
  if (typeof body.threshold === "number") {
    if (!isFinite(body.threshold) || body.threshold <= 0) {
      res.status(400).json({ ok: false, error: "threshold must be a positive number" });
      return;
    }
    setProfitLockThreshold(body.threshold);
  }
  res.json({ ok: true, ...getProfitLockState() });
});

/**
 * POST /api/phemex/update-tps
 *
 * For every open Phemex position tracked as triggered + phemexOrderPlaced:
 *   1. Fetches current OKX perp candles for that symbol + timeframe.
 *   2. Computes the BB30 middle band as the new TP1.
 *      TP2 = same distance extended past TP1 (mirror of TP1 distance from entry).
 *   3. Cancels all resting reduce-only limit orders on Phemex for that side.
 *   4. Places two new half-qty reduce-only GTC limit orders at the new TP1 / TP2.
 *
 * Safe to call multiple times — always cancels before placing.
 */
router.post("/phemex/update-tps", async (req: Request, res: Response) => {
  if (!isPhemexTradingEnabled()) {
    res.status(503).json({ ok: false, error: "Phemex API keys not configured" });
    return;
  }

  // Initialise hedge-mode detection before any position / order calls.
  await getUSDTBalance();

  const allTrades = getAllActiveTradeSymbols();
  const results: Array<{
    symbol: string; timeframe: string;
    newTp1?: number; newTp2?: number;
    result: string;
  }> = [];

  for (const { symbolKey, timeframe } of allTrades) {
    const trade = getActiveTrade(symbolKey, timeframe);
    if (!trade?.triggered || !trade.phemexOrderPlaced) continue;

    // Trending coins: symbolKey IS the Phemex perp symbol (e.g. "ONDOUSDT").
    // Static symbols with a phemexPerp override are uncommon here but handled
    // by the same key since trending coins don't exist in SYMBOLS.
    const phemexSymbol = symbolKey;
    const posSide    = trade.signal === "BUY" ? "Long" as const : "Short" as const;

    try {
      // Derive OKX instId: "ONDOUSDT" → "ONDO-USDT-SWAP"
      const base      = symbolKey.replace(/USDT$/i, "");
      const okxInstId = `${base}-USDT-SWAP`;

      const candles = await fetchOkxPerpCandlesRecent(okxInstId, timeframe, 50);
      if (candles.length < 31) {
        results.push({ symbol: symbolKey, timeframe, result: "Not enough candle data" });
        continue;
      }
      // Exclude the live (incomplete) candle — same convention as signal computation.
      const completed = candles.slice(0, -1);
      const bb30 = calcBollingerBands(completed.map(c => c.close), 30, 2);
      if (!bb30) {
        results.push({ symbol: symbolKey, timeframe, result: "BB30 returned null" });
        continue;
      }

      const pos = await checkExistingPosition(phemexSymbol, posSide);
      if (!pos) {
        results.push({ symbol: symbolKey, timeframe, result: "No open position on Phemex" });
        continue;
      }

      const { size } = pos;
      const halfQty = Math.floor(size / 2);
      if (halfQty < 1) {
        results.push({ symbol: symbolKey, timeframe, result: `Position too small to split (size=${size})` });
        continue;
      }

      // Determine price precision from entry price.
      const ep = trade.entryPrice ?? 0;
      const pxDecimals = ep >= 1000 ? 1 : ep >= 100 ? 2 : ep >= 1 ? 3 : ep >= 0.01 ? 4 : 5;

      // TP1 = BB midline.  TP2 = mirror of the TP1 distance past TP1.
      const newTp1 = parseFloat(bb30.middle.toFixed(pxDecimals));
      const dist   = Math.abs(ep - newTp1);
      const newTp2 = parseFloat((
        posSide === "Short" ? newTp1 - dist : newTp1 + dist
      ).toFixed(pxDecimals));

      // Sanity: TP must be in the right direction from entry.
      const tp1Valid = posSide === "Short" ? newTp1 < ep : newTp1 > ep;
      if (!tp1Valid) {
        results.push({ symbol: symbolKey, timeframe, result: `TP1 ${newTp1} is wrong side of entry ${ep}` });
        continue;
      }

      // Cancel old TPs then place the two new ones.
      await cancelExistingTpOrders(phemexSymbol, posSide);

      await placeLimitClose({
        phemexSymbol,
        posSide,
        priceRp:  newTp1.toFixed(pxDecimals),
        qtyRq:    halfQty.toString(),
        clOrdID:  `phx-tp1-upd-${phemexSymbol}-${Date.now()}`,
      });

      await placeLimitClose({
        phemexSymbol,
        posSide,
        priceRp:  newTp2.toFixed(pxDecimals),
        qtyRq:    halfQty.toString(),
        clOrdID:  `phx-tp2-upd-${phemexSymbol}-${Date.now() + 1}`,
      });

      results.push({ symbol: symbolKey, timeframe, newTp1, newTp2, result: "Updated" });
    } catch (err) {
      results.push({ symbol: symbolKey, timeframe, result: `Error: ${String(err)}` });
    }
  }

  res.json({ ok: true, results });
});

export default router;
