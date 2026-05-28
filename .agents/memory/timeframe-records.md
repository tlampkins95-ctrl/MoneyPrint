---
name: Timeframe Record exhaustiveness
description: Adding a new Timeframe value requires updating Record<Timeframe, …> across many files; pattern for finding all of them
---

## Rule
`Timeframe` is `"15m" | "30m" | "1h" | "4h" | "1d"` (yahoo-fetch.ts). Every `Record<Timeframe, …>` is exhaustively checked by TypeScript — adding a new value causes build errors in all files that define such records.

## Why
Running `pnpm --filter @workspace/api-server run typecheck` catches all gaps at once. When adding 4h, the compiler found 6 records across 4 files (TIMEFRAME_MAP, CACHE_TTL_MS, GATEIO_INTERVAL, DYN_CACHE_TTL_MS, MAX_HOLD_BARS, FIB_MAX_HOLD_BARS). Rely on the type checker rather than manually hunting.

## How to apply
1. Change the `Timeframe` union in `yahoo-fetch.ts`
2. Run `pnpm --filter @workspace/api-server run typecheck` — it lists every exhaustiveness gap
3. Fix each flagged `Record<Timeframe, …>`; run typecheck again until clean
4. Frontend has its own local `Timeframe` type in `timeframe-selector.tsx` (source of truth) and a separate local type in `edge-leaderboard.tsx` — update both
5. Routes with hardcoded VALID_TIMEFRAMES arrays (levels.ts has two) must be updated manually — typecheck won't catch string arrays
6. OpenAPI spec has 4 timeframe enum locations — use `replace_all: true` since they share the same pattern
7. Always run `pnpm --filter @workspace/api-spec run codegen` after OpenAPI changes
