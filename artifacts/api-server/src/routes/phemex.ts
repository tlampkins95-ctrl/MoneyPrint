import { Router, type IRouter, type Request, type Response } from "express";
import { getUSDTBalance, isPhemexTradingEnabled } from "../lib/phemex-trader";

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

export default router;
