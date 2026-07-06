---
name: Auto-trader winning setups
description: Real trades that made money — what signal types, directions, and coins work. Keep making these.
---

## What is working (as of July 2026)

### BB_REJECTION SELL — trending pumping coins
- **Coins**: HYPEUSDT, PENGUUSDT, DYDXUSDT and similar trending coins that have pumped hard
- **Setup**: price hits/exceeds upper BB, MACD histogram declining (3 bars), BW contracting
- **Direction**: SHORT (SELL)
- **Result**: winning — these coins reject hard at the upper band after a pump
- **Gate**: do NOT use higherTfAllowsSell for BB_REJECTION (kills every short in bull markets)

### FIB50_SWING (or similar) BUY — trending coins pulling back
- **Example**: AAVEUSDT LONG — made $80 profit (profit-locked)
- **Direction**: LONG (BUY)
- **Key fact**: this was a BUY, NOT a BB_REJECTION SELL. The $80 AAVE trade was a long.
- **Result**: winning

## Critical distinction: weak pumps vs fundamental pumps

**Weak coins (no catalysts)** → BB_REJECTION SELL is valid. Price pumps on hype alone and fades.
Examples: HYPE, PENGU, DYDX — no team actively supporting price.

**Strong coins with active catalysts** → DO NOT SHORT. Long the pullbacks.
Example: LITUSDT — team doing token burns (6.3% supply reduction), buybacks from exchange revenue. Price is going up for a reason. The LITUSDT long is the CORRECT call even if temporarily underwater.

**Rule**: Before considering a BB_REJECTION SELL on a trending coin, the coin must have no active fundamental catalyst (burn, buyback, major partnership). If the team is actively supporting price, only go long on dips.

## Why this matters
The auto-trader runs on trending coins and fires BOTH directions:
- Short the pumpers at the upper band (BB_REJECTION SELL) — only for weak/hype coins
- Long the dippers/pullbacks (FIB50_SWING BUY or BB_REJECTION BUY) — for strong coins with catalysts

Do NOT constrain the auto-trader to only one direction. Both setups are valid and producing real profits.

**How to apply**: when reviewing or modifying auto-trader signal type allowlist (`PHEMEX_AUTOTRADER_SIGNAL_TYPES`), keep both `FIB50_SWING` and `BB_REJECTION` enabled. Do not remove BUY signals from trending coins just because the recent memorable wins were shorts.
