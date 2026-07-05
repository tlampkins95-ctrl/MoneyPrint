---
name: Risk-based position sizing (NOT margin-based)
description: Sizing is risk-based (qty = dollarRisk / SL_distance). Margin-based was introduced incorrectly by an agent — never the user's strategy. DO NOT change back to margin-based.
---

## CORRECTION — This was wrong

A previous agent session changed sizing to margin-based and recorded it as user-requested. The user never asked for this. It was always risk-based.

## The correct formula

```
dollarRisk = accountSize × PHEMEX_RISK_PCT   (e.g. $1,561 × 4% = $62.44)
slDistance = |entryPrice - stopLoss|
qty        = dollarRisk / slDistance
```

Dollar loss at SL = exactly PHEMEX_RISK_PCT × account, every trade, regardless of SL distance.

**Why:** Margin-based sizing (margin × leverage / price) makes dollar risk depend on SL distance. A wide SL (e.g. $0.21 on LITUSDT at 720 qty) produces a ~$150 loss — 10% of account — instead of the intended 4%. The user explicitly rejected this.

**How to apply:** In `executePhemexTrade` in notifier.ts, use:
```typescript
const dollarRisk = accountSize * phemexRiskPct();
const slDistance = Math.abs(levels.entryPrice - levels.stopLoss);
const rawQty     = slDistance > 0 ? dollarRisk / slDistance : 0;
```

**NEVER revert to:** `const rawQty = (accountSize × riskPct × leverage) / entryPrice`
