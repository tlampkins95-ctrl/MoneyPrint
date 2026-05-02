# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### XAGUSD Silver Screener (`artifacts/xagusd-screener`)
- **Type**: react-vite, served at `/`
- **Purpose**: Professional forex screener/signaler for XAGUSD (Silver)
- **Price data**: Yahoo Finance (`SI=F` — Silver Futures COMEX), fetched server-side, cached 5 minutes
- **Chart**: TradingView Advanced Chart widget, symbol `OANDA:XAGUSD`, dark theme
- **Signals**: 8 technical indicators computed server-side:
  - RSI (14)
  - MACD (12, 26, 9)
  - EMA Cross (9/21)
  - EMA Cross (50/200) — golden/death cross
  - Bollinger Bands (20, 2)
  - Stochastic Oscillator (14, 3, 3)
  - ADX (14)
  - CCI (20)
- **API endpoints**:
  - `GET /api/signals` — all indicator signals
  - `GET /api/signal-summary` — aggregated BUY/SELL/NEUTRAL recommendation + confidence
  - `GET /api/price-history` — OHLCV candle data
- **Auto-refresh**: every 60 seconds

### API Server (`artifacts/api-server`)
- **Type**: Express 5 API, served at `/api`
- **Signals routes**: `src/routes/signals.ts`
