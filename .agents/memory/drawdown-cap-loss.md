---
name: Per-trade $15 drawdown cap
description: Hard dollar loss cap that force-closes open Phemex positions before the original SL, per explicit user rule.
---

Trades that go $15 underwater (unrealized loss) rarely recover, per the user's
direct trading experience. `closeDrawdownCapLosses()` in `notifier.ts` runs
every poll tick (mirrors the existing `lockProfits()` profit-lock pattern) and
market-closes any open position once `unrealisedPnl <= -$15`, cancelling
pending TP/SL orders first.

**Why:** explicit user instruction — real-money account, user said trades past
-$15 "don't tend to recover," wants them closed the moment the threshold is
hit rather than riding to the original (wider) stop-loss.

**How to apply:**
- Threshold is fixed at $15, per-trade (not aggregate across positions), no
  runtime toggle — treat as a strategy rule, not a tunable, unless the user
  says otherwise.
- Applies going forward only — do not retroactively close positions that were
  already past -$15 when the rule was added (user explicitly declined that).
- Closes are recorded to `closed_trades` with outcome `DRAWDOWN_CAP` (distinct
  from `SL`) so drawdown-cap exits are trackable separately from normal
  stop-loss hits.
- If the cap value or scope (per-trade vs aggregate) ever needs to change,
  confirm the exact new spec with the user first — same rule as all other
  strategy/risk changes on this project.
