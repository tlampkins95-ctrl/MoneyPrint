import { Router, type IRouter, type Request, type Response } from "express";
import { Pool } from "pg";
import { GetSignalLogResponse, GetSignalLogQueryParams } from "@workspace/api-zod";

let _pool: Pool | null = null;
function getPool(): Pool | null {
  if (!process.env["DATABASE_URL"]) return null;
  if (!_pool) _pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
  return _pool;
}

const router: IRouter = Router();

router.get("/signal-log", async (req: Request, res: Response) => {
  const parsed = GetSignalLogQueryParams.safeParse(req.query);
  const symbol = parsed.success && parsed.data.symbol ? parsed.data.symbol : null;
  const limit  = parsed.success && parsed.data.limit  ? parsed.data.limit  : 200;

  const pool = getPool();
  if (!pool) {
    res.json(GetSignalLogResponse.parse({ entries: [], total: 0, lastUpdated: new Date().toISOString() }));
    return;
  }

  try {
    const result = symbol
      ? await pool.query(
          `SELECT id, key, symbol, timeframe, signal, signal_type, entry_price, stop_loss,
                  take_profit1, take_profit2, risk_reward_ratio, signal_reason, fired_at
           FROM signal_log
           WHERE symbol ILIKE '%' || $1 || '%'
           ORDER BY fired_at DESC
           LIMIT $2`,
          [symbol, limit],
        )
      : await pool.query(
          `SELECT id, key, symbol, timeframe, signal, signal_type, entry_price, stop_loss,
                  take_profit1, take_profit2, risk_reward_ratio, signal_reason, fired_at
           FROM signal_log
           ORDER BY fired_at DESC
           LIMIT $1`,
          [limit],
        );

    const entries = result.rows.map((row) => ({
      id:              row.id as number,
      key:             row.key as string,
      symbol:          row.symbol as string,
      timeframe:       row.timeframe as string,
      signal:          row.signal as "BUY" | "SELL",
      signalType:      row.signal_type as string,
      entryPrice:      row.entry_price as number,
      stopLoss:        row.stop_loss as number,
      takeProfit1:     row.take_profit1 as number,
      takeProfit2:     row.take_profit2 as number,
      riskRewardRatio: row.risk_reward_ratio as number,
      signalReason:    row.signal_reason as string,
      firedAt:         Number(row.fired_at),
    }));

    res.json(GetSignalLogResponse.parse({
      entries,
      total: entries.length,
      lastUpdated: new Date().toISOString(),
    }));
  } catch (err) {
    req.log.error({ err }, "signal-log query failed");
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;
