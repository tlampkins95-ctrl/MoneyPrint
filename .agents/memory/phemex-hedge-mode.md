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

## minPriceRp clamping (added after hedge mode fix)

placeOrder now fetches all contract specs at startup via fetchContractSpecs()
and clamps priceRp = max(signalEntry, minPriceRp). A limit BUY above market
fills immediately as a taker at real market price. SL/TP are absolute prices
and are accepted regardless of minPriceRp.

Verified live: SOLUSDT at $68.95 → clamped to $100 → code=0, filled at $68.95.

## cancelOrder in hedge mode

cancelOrder also requires posSide query param in hedge mode. OpenPhemexOrder
now stores posSide, passed through to all cancelOrder calls. Tested: cancel
without posSide returns "Required query parameter 'posSide' is not present."
