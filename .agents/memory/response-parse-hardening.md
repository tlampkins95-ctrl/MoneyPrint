---
name: Response parse hardening
description: Hard .parse() on server-own-output crashes entire routes on schema lag; use safeParse with warn+fallback instead.
---

Routes that use `SomeSchema.parse(dataTheyJustBuilt)` blow up with a 500 if the schema is ever one step behind the code (e.g. after adding a timeframe before codegen is deployed). The pattern recurs in levels.ts (active-signals) and backtest.ts.

**Why:** Schema-validate-on-output is defensive but the hard throw kills the entire response. The server just built the data — if the schema rejects it, returning the raw data is always better than a 500.

**How to apply:** Replace `.parse(payload)` with `.safeParse(payload)`, log a warn on failure, and `res.json(parsed.success ? parsed.data : payload)`. Applied in:
- `artifacts/api-server/src/routes/levels.ts` (active-signals route)
- `artifacts/api-server/src/routes/backtest.ts` (query params + response)
