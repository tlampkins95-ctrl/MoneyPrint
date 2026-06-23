import { Router, type IRouter, type Request, type Response } from "express";
import { getUSDTBalance, isPhemexTradingEnabled } from "../lib/phemex-trader";
import { setPhemexAutoTraderEnabled, getPhemexAutoTraderEnabled } from "../lib/notifier";

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

export default router;
