# XAGUSD Silver Screener

Provides professional forex screening and signaling for XAGUSD (Silver) and other trending assets, offering trade setups and real-time signal tracking.

## Run & Operate

- `pnpm run typecheck` — Perform a full typecheck across all packages.
- `pnpm --filter @workspace/api-spec run codegen` — Regenerate API hooks and Zod schemas from the OpenAPI spec.
- `pnpm --filter @workspace/api-server run dev` — Run the API server locally.

**Environment Variables:**
- `ACTIVE_TRADES_FILE`: Path for active trades JSON snapshot (default: `artifacts/api-server/.runtime/active-trades.json`).
- `DATABASE_URL`: PostgreSQL connection string.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`: For Web Push notifications.
- `ENABLE_TELEGRAM_NOTIFIER`, `ENABLE_WEB_PUSH`: Boolean flags to enable/disable notifiers.

## Stack

- **Monorepo**: pnpm workspaces
- **Node.js**: 24
- **TypeScript**: 5.9
- **API Framework**: Express 5
- **Validation**: Zod (v4)
- **API Codegen**: Orval (from OpenAPI spec)
- **Build Tool**: esbuild (ESM bundle)
- **ORM**: _Populate as you build_
- **Database**: PostgreSQL

## Where things live

- `artifacts/xagusd-screener`: Frontend application (React + Vite).
- `artifacts/api-server`: Backend API server (Express).
- `artifacts/api-spec`: OpenAPI specification for API.
- `src/lib/notifier.ts`: Unified signal notification logic.
- `src/lib/signals.ts`: Core signal computation and trade state management.
- `src/lib/trending-discovery.ts`: Logic for discovering and persisting trending coins.
- `src/lib/symbols.ts`: Symbol metadata, including Phemex/MT5/Coinbase configurations.
- `artifacts/api-server/.runtime/active-trades.json`: Source-of-truth for active trade snapshots (runtime).
- `public/sw.js`: Service worker for Web Push notifications.
- `index.css`: Global stylesheet.

## Architecture decisions

- **Dual Persistence for Active Trades**: Active trades are snapshotted to a local JSON file for fast restarts and asynchronously upserted to PostgreSQL for production durability. This ensures resilience against server restarts and deployments.
- **Unified Signal Notifier**: A single polling mechanism `notifier.ts` fans out signal transitions to multiple channels (Telegram, Web Push), allowing independent kill-switches and centralized management.
- **Venue-Aware Position Sizing**: Position sizing logic is highly customized per trading venue (Phemex, MT5, Coinbase Spot) to accurately reflect exchange-specific constraints, contract sizes, and leverage rules, providing precise trade instructions.
- **Machine-Readable Trade State**: The `tradeState` field (`WAIT | PENDING | FILLED_PROFIT | ...`) is explicitly typed and returned by the API, mandating UI consumers to branch on this field rather than parsing human-readable prose, ensuring robust client-side logic.
- **Dynamic Symbol Support**: The system supports dynamic, trending symbols from CoinGecko/OKX, extending core signal logic and UI components to handle symbols not predefined in the static `Symbol` enum.

## Product

- **Real-time XAGUSD Signals**: Provides BUY/SELL/WAIT signals for XAGUSD based on `PIVOT_BOUNCE` (mean-reversion) and `BREAKOUT` (momentum) strategies across multiple timeframes.
- **Active Signals Overview**: A dashboard component displaying all live BUY/SELL signals across various symbols and timeframes, with fill tracking and P&L calculations.
- **Edge Matrix Leaderboard**: A backtest statistics grid for 9 symbols × 5 timeframes, sortable and filterable by signal type (Pivot/Breakout), allowing users to discover top-performing setups.
- **Web Push Notifications**: Browser-based alerts for signal transitions, offering a real-time, branded notification channel alongside Telegram.
- **Auto-trending Coin Discovery**: Automatically identifies and integrates trending cryptocurrencies from CoinGecko/OKX into the signaling system, expanding coverage beyond static symbols.

## User preferences

- Do NOT modify `TradingViewChart.tsx`.
- Google Fonts `@import url(...)` MUST be the absolute first line of `index.css`.

## Gotchas

- **1m Timeframe**: The 1m timeframe has been removed and is not supported anywhere.
- **TradingView Chart Widget**: `TradingViewChart.tsx` should not be modified, as it's a critical, fixed component.
- **Web Push Notifier in Production**: Web Push and Telegram notifiers are forced OFF in production `artifact.toml` until deployment moves to a Reserved VM, as autoscaling can terminate the notifier process.
- **Typed Trade State**: UI must rely on the `tradeState` field for logic, not the human-readable `signalReason` text.

## Pointers

- **pnpm-workspace skill**: For monorepo structure, TypeScript setup, and package details.
- **OpenAPI v0.2.0**: For API endpoint documentation.
- **`@workspace/db` package**: For database interactions and schema.
- **TradingView Advanced Chart widget documentation**: For chart customization.