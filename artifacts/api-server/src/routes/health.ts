import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { sendTelegramTest } from "../lib/telegram-notifier";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.post("/admin/notify-test", async (req, res) => {
  const secret = req.headers["x-admin-secret"];
  if (secret !== process.env["ADMIN_SECRET"]) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const result = await sendTelegramTest();
  res.json(result);
});

export default router;
