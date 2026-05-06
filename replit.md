# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Validation**: Zod (`zod/v4`)
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (ESM bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### XAGUSD Silver Screener (`artifacts/xagusd-screener`)
- **Type**: react-vite, served at `/`
- **Purpose**: Professional forex screener/signaler for XAGUSD (Silver)
- **Price data**: Yahoo Finance (`SI=F` — Silver Futures COMEX), fetched server-side, cached 5 minutes
- **Chart**: TradingView Advanced Chart widget, symbol `OANDA:XAGUSD`, dark theme — do NOT modify `TradingViewChart.tsx`
- **Signal logic**: Single clear BUY / SELL / WAIT signal derived from price levels, NOT from multiple competing indicators
  - Classic daily pivot points (P, S1/S2/S3, R1/R2/R3) from prior session OHLC
  - Camarilla pivot points for tighter intraday confluence
  - Fibonacci retracement (23.6%, 38.2%, 50%, 61.8%, 78.6%) from 60-bar swing high/low
  - BUY ZONE = confluence of S1/S2 + Fib 61.8%/50% + Cam S1/S2
  - SELL ZONE = confluence of R1/R2 + Fib 23.6% + Cam R1/R2
  - Signal = BUY if price in/approaching buy zone; SELL if in/approaching sell zone; else WAIT
  - ATR(14) used for stop-loss sizing (0.5× ATR beyond zone boundary)
  - EMA 21/50 for trend bias display (UPTREND/DOWNTREND/RANGING) — informational only, NOT a signal gate
  - RSI(14) is the only entry gate: BUY requires RSI ≤ 35 (oversold), SELL requires RSI ≥ 65 (overbought). EMA21/50, MACD, and EMA200 were removed as gates — they confirm the pump/dump itself, not the reversal, causing false negatives on the exact setups we want to trade.
- **Trade output**: Entry, Stop Loss, Take Profit 1, Take Profit 2, Risk/Reward ratio
- **Frozen trade snapshots**: When a BUY/SELL fires, the entry/SL/TP/RR/zones/pivot are snapshotted server-side and remain frozen until invalidated. Three invalidation triggers: (1) price hits SL, (2) price hits TP2, (3) the live signal flips to the opposite direction (e.g. active SELL but fresh logic says BUY). WAIT does NOT invalidate. Dual persistence: (1) sync write to `artifacts/api-server/.runtime/active-trades.json` (fast, survives restarts), (2) async upsert to `active_trades` PostgreSQL table (survives production deployments). On server startup, `loadActiveTradesFromDisk()` reads the JSON file synchronously, then `syncFromDb()` runs in background and merges any DB rows not in the file — this recovers all active trades after a fresh deploy where the JSON file starts empty. See `computeLevelsStable`, `loadActiveTradesFromDisk`, `syncFromDb`, and `persistActiveTrades` in `signals.ts`. Override JSON path with `ACTIVE_TRADES_FILE` env var.
- **Fill tracking (triggered/MISSED)**: Snapshots fire when price is "approaching" the zone, but the limit order at `entryPrice` may never actually be tagged. `ActiveTrade.triggered` tracks whether the order really filled. Set `true` either at snapshot time (price already at/past entry) or later when (a) live spot crosses entry or (b) a candle wick reaches entry. The wick scan uses a baseline (`openedCandleLow/High` captured at snapshot) so the in-progress candle only counts post-snapshot extensions — eliminates false positives from pre-open wicks earlier in the same candle. If a still-pending limit reaches TP1, the trade is auto-deleted as MISSED so a fresh snapshot can take over. `describeFrozenTrade` reads `triggered` to surface honest language: "BUY setup PENDING — price moved $X above entry without tagging it" vs "BUY filled at $Y, in profit (+0.5R)". Telegram alerts inherit the same text via `levels.signalReason`.
- **No 1m timeframe** — removed everywhere; only 15m/30m/1h/1d are supported.
- **Edge Matrix leaderboard**: `EdgeLeaderboard` component on the dashboard renders a 9 symbols × 5 timeframes grid of cached backtest stats. Sortable by Win Rate / Total Return / Profit Factor. Color-coded: ≥55% green, 50-55% amber, <50% red. Gold ring marks the top setup overall by selected metric; amber ring marks each asset's best timeframe. Click any cell to load that symbol+timeframe. Cells are loaded via 45 parallel `useGetBacktest` hooks; results published to parent via stable JSON-signature `useEffect` to avoid re-render loops.
- **Active Signals Overview**: `ActiveSignalsOverview` component on the dashboard shows every currently-live BUY/SELL across 9 symbols × 4 timeframes (15m/30m/1h/1d) in one place. Backed by `GET /api/active-signals`, which: (a) dedupes spot-price upstream calls — fetches each symbol's spot ONCE per request and shares the promise across that symbol's 4 timeframes (was 4× before, causing thundering-herd pressure on OANDA/OKX before the cache populated); (b) recomputes every combo via `computeLevelsStable` in parallel; (c) returns only BUY/SELL entries plus a `coverage` block (`{total, succeeded, failed, failedSymbols}`) so the UI can distinguish "no signals" from "data feed degraded". The UI surfaces an amber warning banner whenever `coverage.failed > 0`. Each row shows symbol badge, TF, BUY/SELL pill, the dynamic state line, price quartet (Now/Entry/SL/TP1), and Phemex $col×lev → SL/TP1/TP2 dollar P&L. Clicking a row deep-links the chart + signal panel to that symbol+timeframe.
- **Typed `tradeState` field** (`LevelsData.tradeState`): every `/levels` and `/active-signals` response carries a machine-readable lifecycle state: `WAIT | PENDING | FILLED_PROFIT | FILLED_DRAWDOWN | FILLED_TP1 | FILLED_TP2 | FILLED_SL`. Computed by `classifyTradeState(trade, currentPrice)` in `signals.ts` and mirrored alongside the human-readable `signalReason`. **UI consumers must branch on `tradeState`, never parse the prose** — the prose is for display only and its wording is not part of the contract. The `ActiveSignalsOverview` grouping (Filled / Pending / Other) and any future client logic should always use this field. `computeLevels` defaults new BUY/SELL to `PENDING` and WAIT to `WAIT`; `computeLevelsStable` upgrades to a triggered state via `classifyTradeState` in both the frozen-trade path and the new-snapshot path (when a snapshot fires with price already past entry).
- **Position sizing (venue-aware)**: every `PositionSizing` is tagged with a `venue` of `"PHEMEX"` (BTC/ETH on Phemex USDT-margined perps), `"MT5"` (XAU/XAG + EURUSD/GBPUSD/AUDUSD/USDJPY/GBPJPY on MetaTrader 5), or `"COINBASE_SPOT"` (SKYAIUSDT and future Coinbase spot tokens — no leverage, whole-token sizing). The dashboard, Telegram alerts and the active-signals overview all branch on `venue` so the dollar P&L always reflects the actual exchange.
  - **PHEMEX venue** (`achievable` block): maps the ideal trade onto Phemex's USDT-perp envelope. The binding floor is the **contract minimum** in coin units — BTCUSDT trades in 0.001 BTC increments, ETHUSDT in 0.01 ETH (`phemexMinQty` / `phemexQtyStep` in `symbols.ts`). The screener rounds qty DOWN to the step, and forces qty up to `minQty` when the ideal is below 1 contract (the OVER-SIZED case). Forced trades take maxLev so collateral stays tiny — Phemex doesn't require a $X collateral floor, only ≥1 contract of notional. The legacy `minCollateral` / `maxLeverage` query params (defaults: $1 / 100×) still apply: max-leverage caps risk; min-collateral acts as a user safety floor that bumps collateral up and lowers leverage when at maxLev would be below it. Cases: (A) ideal stepped qty achievable at maxLev with col≥min → use maxLev; (B) at maxLev would dip below min collateral → bump col to min, lower leverage; (C) stepped qty < minQty → forced to minQty at maxLev, scale-factor scales risk and dollar P&L proportionally, warning emitted (e.g. "Ideal position smaller than Phemex contract minimum (0.001 BTC ≈ $78.57) — forced 1196% over-sized.").
  - **MT5 venue** (`mt5` block): user-chosen lot size (default 0.01, configurable via `mt5Lots` query param, persisted to `screener.mt5Lots` in localStorage). Computes USD P&L from contract size × price distance: forex 100k base, XAU 100oz, XAG 5000oz; USDJPY uses entry-price quote conversion, GBPJPY reads live USDJPY from the spot-price cache (falls back to a 150 constant only on cold start). Reports lots, contractSize, positionSize/Unit, notional, pnlAtSL/TP1/TP2 and `riskPctOfAccount` for sanity-checking that the chosen lots aren't over-leveraging the account. Also returns `recommendedLots` (the lot size that risks the configured `riskPct` of `accountSize` on SL hit, floored to 0.01 increments) and `recommendedTargetRiskPct`. The signal panel surfaces this as an amber "≈ X.XX for Y%" button next to the lots input that one-click applies the recommendation — fixes the "0.01 lots = $0.38 trade" footgun on small accounts and small-pip pairs like AUDUSD.
  - **COINBASE_SPOT venue** (`spotToken` block): fires for any symbol that has a `coinbase` field but no `phemexPerp` or `goldApi` (currently SKYAIUSDT only). `tokenCount = floor(riskAmount / |entry − stopLoss|)` in whole tokens, plus notional, riskAmount/riskPct, and pnlAtSL/TP1/TP2. The signal panel shows a "Buy N SKYAI" row, notional, and an "EXACT TRADE TO PLACE · COINBASE" block styled in sky-blue. Controls strip shows only account size + risk% (no leverage input). Active signals overview shows "COINBASE N SKYAI → SL/TP1/TP2 $".
  - The signal panel renders different "EXACT TRADE TO PLACE" blocks per venue (LOTS/POSITION/NOTIONAL for MT5, COLLATERAL/LEVERAGE/POSITION for PHEMEX, BUY tokens/NOTIONAL for COINBASE_SPOT), and the controls strip swaps to match (lots for MT5, risk% only for spot, risk%+leverage for PHEMEX).
- **API endpoints** (OpenAPI v0.2.0):
  - `GET /api/levels` — key price levels + single BUY/SELL/WAIT signal + full trade setup
  - `GET /api/price-history?bars=60` — OHLCV candle data
  - `GET /api/active-signals` — every live BUY/SELL across symbols × timeframes
  - `GET /api/healthz` — health check
  - `GET /api/push/vapid-public-key` — VAPID public key for browser subscription
  - `POST /api/push/subscribe` — register a Web Push subscription (idempotent upsert by endpoint)
  - `POST /api/push/unsubscribe` — remove a subscription
- **Web Push notifications**: lock-screen browser alerts as a branded alternative/companion to Telegram. The unified signal notifier (`src/lib/notifier.ts`) polls every 60s and fans transitions to ALL enabled channels — Telegram (`telegram-notifier.ts`) and Web Push (`web-push-notifier.ts`) — each independently kill-switched. Subscriptions persist in Postgres (`push_subscriptions` table via `@workspace/db`). Dead subscriptions (404/410 from FCM/APNs) are auto-deleted. Frontend toggle (`PushNotificationsToggle`) registers `/sw.js`, calls `PushManager.subscribe` with the server's VAPID public key, and POSTs the subscription. Kill switches: `ENABLE_TELEGRAM_NOTIFIER` and `ENABLE_WEB_PUSH` (both default ON when their creds exist; both forced OFF in production artifact.toml until deploy moves to Reserved VM — autoscale scales to zero and kills the in-process notifier loop). VAPID env vars: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (shared environment).
- **Auto-refresh**: every 60 seconds
- **CSS rule**: Google Fonts `@import url(...)` MUST be the absolute first line of `index.css`

### API Server (`artifacts/api-server`)
- **Type**: Express 5 API, served at `/api`
- **Route file**: `src/routes/levels.ts` (replaces old `signals.ts`)
- **Database**: PostgreSQL (`active_trades` table) used for durable active-trade persistence across deployments. Signal data still fetched from Yahoo Finance and cached in-memory (5 min TTL). `pg` pool in `signals.ts` via `DATABASE_URL`.
