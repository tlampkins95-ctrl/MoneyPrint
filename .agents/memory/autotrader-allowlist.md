---
name: Auto-trader signal allowlist — 3 places
description: Every new signalType must be added to 3 separate allowlist locations or Phemex auto-trade silently skips it.
---

When adding a new `signalType` to the auto-trader, there are **3 places** that must all be updated:

1. `DEFAULT_ALLOWED_SIGNAL_TYPES` constant in `notifier.ts` (the in-code fallback, line ~318)
2. `PHEMEX_AUTOTRADER_SIGNAL_TYPES` shared env var (overrides the hardcoded default at runtime)
3. `PHEMEX_AUTOTRADER_SIGNAL_TYPES` in `artifact.toml` `[services.production.run.env]` block

**Why:** The env var override takes precedence over the hardcoded default. If the env var is set (it is, via Replit shared secrets), only the env var value matters — updating only the code constant has no effect in dev or prod. All 3 must match.

**How to apply:** Any time a new signalType is wired to `executePhemexTrade`, immediately update all 3 locations in the same PR. The symptom of missing this is `"auto-trade skipped — signal type not in allowlist"` in the logs with the old allowlist string still showing.

Current allowlist (as of 2026-07-06): `FIB50_SWING,BB_REJECTION,DOUBLE_BOTTOM,DOUBLE_TOP,BB_BREAKOUT,MACD_DIP_LONG`
