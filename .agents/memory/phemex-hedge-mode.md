---
name: Phemex hedge mode auto-detection
description: Phemex account is in hedge mode (userMode=1); every order needs posSide=Long/Short or it gets code 39999
---

## The rule

Phemex accounts can be in one-way mode (userMode=0) or hedge/two-way mode (userMode=1).
In hedge mode, **every** order must include `posSide: "Long"` (for Buy) or `"Short"` (for Sell).
Without it, Phemex returns code 39999 "Error in place order" with no other detail.

The auto-trader account is userMode=1 (confirmed June 2026).

## Why this was missed

The `PHEMEX_HEDGE_MODE` env var existed but was never set, so `hedgeMode` defaulted to `false` and `posSide` was never included. Code 39999 is a completely generic error that gave no hint as to why. Every debugging attempt (removing SL/TP, removing triggerType, etc.) was attacking the wrong field.

## Fix applied

`getUSDTBalance()` now reads `userMode` from the account response and caches it as `detectedHedgeMode`. `placeOrder()` calls `resolveHedgeMode()` which prefers the env var override, falls back to the detected value. No manual config required.

## How to apply

- Never assume one-way mode. If a future account is in one-way mode the auto-detection handles it.
- If orders start failing with 39999 after an account change, check `userMode` from `/g-accounts/accountPositions`.
- The detection log line: `"phemex-trader: account position mode detected"` with `hedgeMode: true/false`.

## minPriceRp clamping — asymmetric by side

placeOrder fetches all contract specs at startup via fetchContractSpecs()
and applies different logic per side:

**BUY** (side="Buy") when entry < minPriceRp:
  - Clamp priceRp UP to minPriceRp.
  - A limit BUY above market fills immediately as a taker at real market price. ✓
  - Verified live: SOLUSDT at $68.95 → clamped to $100 → code=0, filled at $68.95.

**SELL** (side="Sell") when entry < minPriceRp:
  - Clamping UP does NOT work: limit SELL above market sits resting (won't fill
    at market), AND Phemex rejects it with code 11052 `TE_SELL_SL_SHOULD_GT_BASE`
    because SL (above signal entry ~$69) is BELOW the clamped priceRp ($100).
  - Fix: use ordType="Market" + timeInForce="ImmediateOrCancel". No priceRp field.
    SL/TP are still included and accepted at their real levels.
  - Verified live: XAGUSDT SELL at $59, minPriceRp=100 → Market IOC → code=0. ✓

**Unknown symbol** (not in contractSpecCache despite specs being loaded):
  - Return null early with a warning log. Prevents code 39999 "Symbol not listed"
    on trending coins that are not listed as Phemex perps (e.g. HUSDT).

## cancelOrder in hedge mode

cancelOrder also requires posSide query param in hedge mode. OpenPhemexOrder
now stores posSide, passed through to all cancelOrder calls. Tested: cancel
without posSide returns "Required query parameter 'posSide' is not present."
