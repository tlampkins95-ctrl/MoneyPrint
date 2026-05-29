---
name: OpenAPI enum completeness
description: The ActiveSignalsEntry schema in openapi.yaml has a 4th timeframe enum that replace_all misses — always verify all 4 locations after adding a timeframe.
---

The OpenAPI spec has 4 separate timeframe enum locations. Three are siblings under a `properties` block with a `default:` key — `replace_all` hits those fine. The fourth is inside `ActiveSignalsEntry` schema and has NO `default:` key, giving it a different YAML structure. A `replace_all` on the pattern `enum: ["15m", "30m", "1h", "1d"]` missed it every time.

**Why:** `replace_all` matches the exact YAML string including surrounding context. The 4th location differs by one absent sibling key, so the replace target string doesn't match.

**How to apply:** After any timeframe change + codegen, grep the generated `api.ts` for the count of `.enum(["15m",` — it must be exactly 4. If it's 3, line 865 of openapi.yaml (or near it, inside `ActiveSignalsEntry`) was missed.
