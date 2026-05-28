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

router.get("/admin/telegram-updates", async (req, res) => {
  const secret = req.headers["x-admin-secret"];
  if (secret !== process.env["ADMIN_SECRET"]) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) { res.status(500).json({ error: "No bot token" }); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=20`, {
      signal: AbortSignal.timeout(8000),
    });
    const body = await r.json() as { ok: boolean; result?: Array<{ message?: { chat: { id: number; username?: string; first_name?: string }; text?: string; date: number } }> };
    const chats = (body.result ?? [])
      .filter(u => u.message)
      .map(u => ({
        chat_id: u.message!.chat.id,
        username: u.message!.chat.username,
        name: u.message!.chat.first_name,
        text: u.message!.text,
        date: new Date(u.message!.date * 1000).toISOString(),
      }));
    res.json({ ok: body.ok, chats });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
