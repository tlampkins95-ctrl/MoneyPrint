import { Router, type IRouter, type Request, type Response } from "express";
import { Pool } from "pg";
import { getAllActiveAlerts } from "../lib/fib786-alerts";

let _pool: Pool | null = null;
function getPool(): Pool | null {
  if (!process.env["DATABASE_URL"]) return null;
  if (!_pool) _pool = new Pool({ connectionString: process.env["DATABASE_URL"], ssl: { rejectUnauthorized: false } });
  return _pool;
}

const router: IRouter = Router();

// Real (not backtested) FIB786 performance — closed outcomes from the
// fib786_alerts table plus currently-open alerts still being tracked
// in-memory. There was previously no way to see this at all; the engine
// logged outcomes to the DB on close but nothing ever read them back.
router.get("/fib786-history", async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query["limit"]) || 100, 500);
  const activeAlerts = getAllActiveAlerts();

  const pool = getPool();
  if (!pool) {
    res.json({
      closedTrades: [],
      activeAlerts,
      stats: { totalClosed: 0, wins: 0, losses: 0, totalR: 0, winRate: 0 },
      note: "No DATABASE_URL configured — closed-trade history is unavailable, only in-memory active alerts are shown.",
    });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT id, key, symbol, entry_price, stop_loss, tp1, tp2, tp1_filled, tp2_filled,
              exit_price, outcome, r_multiple, fired_at, closed_at
       FROM fib786_alerts
       WHERE closed_at IS NOT NULL
       ORDER BY closed_at DESC
       LIMIT $1`,
      [limit],
    );

    const closedTrades = result.rows.map((row) => ({
      id: row.id as number,
      key: row.key as string,
      symbol: row.symbol as string,
      entryPrice: row.entry_price as number,
      stopLoss: row.stop_loss as number,
      tp1: row.tp1 as number,
      tp2: row.tp2 as number,
      tp1Filled: row.tp1_filled as boolean,
      tp2Filled: row.tp2_filled as boolean,
      exitPrice: row.exit_price as number,
      outcome: row.outcome as string,
      rMultiple: row.r_multiple as number,
      firedAt: Number(row.fired_at),
      closedAt: Number(row.closed_at),
    }));

    const wins = closedTrades.filter((t) => t.rMultiple > 0).length;
    const losses = closedTrades.filter((t) => t.rMultiple <= 0).length;
    const totalR = closedTrades.reduce((sum, t) => sum + t.rMultiple, 0);

    res.json({
      closedTrades,
      activeAlerts,
      stats: {
        totalClosed: closedTrades.length,
        wins,
        losses,
        totalR: Math.round(totalR * 100) / 100,
        winRate: closedTrades.length > 0 ? Math.round((wins / closedTrades.length) * 1000) / 10 : 0,
      },
    });
  } catch (err) {
    req.log.error({ err }, "fib786-history query failed");
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;
