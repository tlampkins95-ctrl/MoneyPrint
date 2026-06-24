---
name: Auto-trader production default
description: phemexAutoTraderEnabled defaults to false in production on every fresh deploy because the runtime state file is wiped.
---

## The bug

`loadAutoTraderState()` returns `false` when no state file exists. In production, `.runtime/auto-trader-state.json` is wiped on every deploy, so the auto-trader starts DISABLED regardless of whether `isPhemexTradingEnabled()` is true.

Signal fires, Telegram/Push send correctly, but zero Phemex order is attempted — and there is no log line explaining why (the `void executePhemexTrade(...)` branch is simply never entered).

**Why:** The file-based persistence was designed for dev where the file persists across restarts, but production ephemeral storage resets it every deployment.

## Fix

`loadAutoTraderState()` now falls back to `process.env["PHEMEX_AUTO_TRADER"]` when no file exists. `PHEMEX_AUTO_TRADER=true` is set in `artifact.toml` production env, so production starts hot.

## How to apply

- If the auto-trader is ever silently not firing: check the startup log for `phemexAutoTraderOn: false`.
- Startup log now emits `phemexOn` and `phemexAutoTraderOn` fields — both must be `true` for trading to work.
- If `phemexOn` is `false`, `PHEMEX_API_KEY`/`PHEMEX_API_SECRET` are missing from the environment.
- If `phemexAutoTraderOn` is `false`, the state file has `enabled: false` or the env var is missing.
