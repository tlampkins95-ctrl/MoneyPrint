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
  - EMA 21/50 for trend bias (UPTREND/DOWNTREND/RANGING)
- **Trade output**: Entry, Stop Loss, Take Profit 1, Take Profit 2, Risk/Reward ratio
- **API endpoints** (OpenAPI v0.2.0):
  - `GET /api/levels` — key price levels + single BUY/SELL/WAIT signal + full trade setup
  - `GET /api/price-history?bars=60` — OHLCV candle data
  - `GET /api/healthz` — health check
- **Auto-refresh**: every 60 seconds
- **CSS rule**: Google Fonts `@import url(...)` MUST be the absolute first line of `index.css`

### API Server (`artifacts/api-server`)
- **Type**: Express 5 API, served at `/api`
- **Route file**: `src/routes/levels.ts` (replaces old `signals.ts`)
- **No database** — all data fetched from Yahoo Finance and cached in-memory (5 min TTL)
