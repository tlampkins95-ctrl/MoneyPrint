import { Router, type IRouter, type Request, type Response } from "express";
import { Pool } from "pg";
import { GetTradeHistoryResponse, GetTradeHistoryQueryParams } from "@workspace/api-zod";

let _pool: Pool | null = null;
function getPool(): Pool | null {
  if (!process.env["DATABASE_URL"]) return null;
  if (!_pool) _pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
  return _pool;
}

const router: IRouter = Router();

router.get("/trade-history", async (req: Request, res: Response) => {
  const parsed = GetTradeHistoryQueryParams.safeParse(req.query);
  const symbol = parsed.success && parsed.data.symbol ? parsed.data.symbol : null;
  const limit = parsed.success && parsed.data.limit ? parsed.data.limit : 100;

  const pool = getPool();
  if (!pool) {
    const payload = GetTradeHistoryResponse.parse({
      trades: [],
      totalTrades: 0,
      totalR: 0,
      winCount: 0,
      lossCount: 0,
      lastUpdated: new Date().toISOString(),
    });
    res.json(payload);
    return;
  }

  try {
    const result = symbol
      ? await pool.query(
          `SELECT id, key, symbol, timeframe, signal, signal_type, entry_price, stop_loss,
                  take_profit1, take_profit2, risk_reward_ratio, exit_price, outcome,
                  r_multiple, tp1_hit, opened_at, closed_at
           FROM closed_trades
           WHERE symbol ILIKE '%' || $1 || '%'
           ORDER BY closed_at DESC
           LIMIT $2`,
          [symbol, limit],
        )
      : await pool.query(
          `SELECT id, key, symbol, timeframe, signal, signal_type, entry_price, stop_loss,
                  take_profit1, take_profit2, risk_reward_ratio, exit_price, outcome,
                  r_multiple, tp1_hit, opened_at, closed_at
           FROM closed_trades
           ORDER BY closed_at DESC
           LIMIT $1`,
          [limit],
        );

    const trades = result.rows.map((row) => ({
      id: row.id as number,
      key: row.key as string,
      symbol: row.symbol as string,
      timeframe: row.timeframe as string,
      signal: row.signal as "BUY" | "SELL",
      signalType: row.signal_type as "PIVOT_BOUNCE" | "BREAKOUT",
      entryPrice: row.entry_price as number,
      stopLoss: row.stop_loss as number,
      takeProfit1: row.take_profit1 as number,
      takeProfit2: row.take_profit2 as number,
      riskRewardRatio: row.risk_reward_ratio as number,
      exitPrice: row.exit_price as number,
      outcome: row.outcome as "SL" | "BE_TRAIL" | "TP2" | "REVERSED" | "MISSED",
      rMultiple: row.r_multiple as number,
      tp1Hit: row.tp1_hit as boolean,
      openedAt: row.opened_at != null ? Number(row.opened_at) : undefined,
      closedAt: Number(row.closed_at),
    }));

    const realTrades = trades.filter((t) => t.outcome !== "MISSED" && t.outcome !== "REVERSED");
    const totalR = realTrades.reduce((sum, t) => sum + t.rMultiple, 0);
    const winCount = trades.filter((t) => t.outcome === "TP2" || t.outcome === "BE_TRAIL").length;
    const lossCount = trades.filter((t) => t.outcome === "SL").length;

    const payload = GetTradeHistoryResponse.parse({
      trades,
      totalTrades: trades.length,
      totalR: Math.round(totalR * 100) / 100,
      winCount,
      lossCount,
      lastUpdated: new Date().toISOString(),
    });
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "trade-history query failed");
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;
