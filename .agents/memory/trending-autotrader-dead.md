---
name: Trending coin auto-trader dead
description: Three stacked bugs made auto-trading completely non-functional for all trending coins (ONDO, BEAT, HYPE, etc.)
---

## The three bugs

**Bug 1 — executePhemexTrade bailed immediately**
`const meta = SYMBOLS[symbol as Symbol]; if (!meta) return;`
Trending coins are not in the static SYMBOLS table, so this always returned undefined and exited. No order was ever attempted.

**Fix:** Added optional `trendingMeta?: TrendingTradeMeta` parameter. When provided, constructs a synthetic SymbolMeta with `okxPerp` set (non-empty string triggers the crypto sizing branch in computePositionSizing), plus decimals/qtyStep/minQty from the trending coin's DB record.

**Bug 2 — wrong phemexSymbol source in checkTrendingSymbol**
```ts
const phemexSymbol = SYMBOLS[symbolKey as Symbol]?.phemexPerp; // always undefined
```
Should have been `tMeta.phemexPerp` — the exchange symbol is stored directly on TrendingMeta.

**Bug 3 — no catch-up block in checkTrendingSymbol**
`checkSymbol` had a catch-up block that fires when signal=PENDING and no open order is tracked (handles restarts and enable-while-live). `checkTrendingSymbol` had nothing equivalent.

**Fix:** Added identical catch-up block at the end of checkTrendingSymbol.

## Why: Always verify both code paths

checkSymbol and checkTrendingSymbol are separate functions. Any auto-trader feature added to one must be explicitly mirrored in the other. The pattern diverged silently — the comment "this is a no-op for most of them" in the original code was a red flag that was left unaddressed.

## How to apply

When touching auto-trader logic in notifier.ts, always search for both functions and verify symmetry.
