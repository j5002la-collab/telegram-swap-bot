---
id: "001"
plan: "001-swap-bot-plan.md"
version: "1.0.0"
created: "2026-05-13"
---

# Telegram Swap Bot — Tasks

## Phase 1: Foundation

### T-001: Project scaffold
- Initialize npm project with `npm init`
- Create `tsconfig.json` (strict mode, ES2022, target Node 18+)
- Install dependencies: telegraf, mongoose, axios, ws, node-schedule, winston, dotenv
- Install dev deps: typescript, @types/node, @types/ws, eslint, prettier, mocha, chai, ts-node
- Create `src/index.ts` entry point
- Add scripts to package.json: `start`, `dev`, `build`, `test`
- **Files**: `package.json`, `tsconfig.json`, `.eslintrc.json`, `.prettierrc`

### T-002: Configuration + Logger
- Create `.env-sample` with all config vars
- Create `src/utils/config.ts` — typed config loader from env
- Create `src/utils/logger.ts` — Winston logger with console + file transports
- **Files**: `.env-sample`, `src/utils/config.ts`, `src/utils/logger.ts`

### T-003: MongoDB models
- Create `src/models/User.ts` — Mongoose schema
- Create `src/models/Swap.ts` — Mongoose schema
- Create `src/models/Raffle.ts` — Mongoose schema
- Create `src/models/index.ts` — connect + export
- **Files**: `src/models/*.ts`

### T-004: Telegraf skeleton
- Create `src/bot/bot.ts` — init Telegraf with config
- Create `src/bot/commands/start.ts` — /start handler (welcome + menu)
- Create `src/bot/commands/help.ts` — /help handler
- Create `src/bot/middleware/user.ts` — track every user
- Wire middleware + commands in bot.ts
- **Files**: `src/bot/bot.ts`, `src/bot/commands/start.ts`, `src/bot/commands/help.ts`, `src/bot/middleware/user.ts`

## Phase 2: Boltz Integration

### T-005: Boltz HTTP client
- Create `src/boltz/types.ts` — TypeScript interfaces for Boltz API responses
- Create `src/boltz/client.ts` — axios-based client with methods:
  - `getSubmarinePairs()`
  - `getReversePairs()`
  - `getChainPairs()`
  - `createSubmarineSwap(params)`
  - `createReverseSwap(params)`
  - `getSwapStatus(swapId)`
- **Files**: `src/boltz/types.ts`, `src/boltz/client.ts`

### T-006: Boltz WebSocket manager
- Create `src/boltz/websocket.ts` — WebSocket connection manager
  - Connect to Boltz WS endpoint
  - Subscribe to swap updates
  - Emit events on status changes
  - Auto-reconnect on disconnect
- **Files**: `src/boltz/websocket.ts`

### T-007: Swap orchestration
- Create `src/boltz/swap.ts` — full swap lifecycle:
  - Create swap via Boltz API
  - Subscribe to WebSocket updates
  - Monitor status transitions
  - Handle success: notification
  - Handle failure: refund instructions
  - Handle timeout: cleanup
- **Files**: `src/boltz/swap.ts`

### T-008: Rate engine
- Create `src/engine/rates.ts`:
  - Fetch current rates from Boltz pairs
  - Apply bot commission markup
  - Cache rates (TTL: 30 seconds)
  - Format for display (BTC↔USD, sats↔USDT)
- **Files**: `src/engine/rates.ts`

## Phase 3: Swap Flow

### T-009: Commission engine
- Create `src/engine/commission.ts`:
  - Calculate bot commission (2.5% configurable)
  - Calculate Boltz commission (from pairs)
  - Show full fee breakdown
  - Validate minimum commission threshold
- **Files**: `src/engine/commission.ts`

### T-010: /swap command
- Create `src/bot/commands/swap.ts`:
  - Step 1: Select direction (USDT→BTC, BTC→USDT, etc.)
  - Step 2: Enter amount (with validation)
  - Step 3: Show fee breakdown
  - Step 4: Confirm / Cancel
  - Step 5: Execute swap via Boltz engine
  - Step 6: Show completion / error
- **Files**: `src/bot/commands/swap.ts`

### T-011: /rates command
- Create `src/bot/commands/rates.ts`:
  - Fetch current rates from engine
  - Display in nice Telegram format
  - Auto-refresh option (inline button)
- **Files**: `src/bot/commands/rates.ts`

## Phase 4: Admin & Raffle

### T-012: Weekly raffle engine
- Create `src/engine/raffle.ts`:
  - Track weekly swap volume per user
  - Calculate prize pool (0.1% of volume)
  - Weighted random selection
  - Payout via Boltz reverse swap
  - Log results
- **Files**: `src/engine/raffle.ts`

### T-013: Raffle scheduler
- Create `src/jobs/raffle-draw.ts`:
  - node-schedule: every Sunday 23:59 UTC
  - Trigger draw via raffle engine
  - Notify winner in DM
  - Announce in channel
- **Files**: `src/jobs/raffle-draw.ts`

### T-014: /raffle command
- Create `src/bot/commands/raffle.ts`:
  - Show current week prize pool
  - Show user's tickets
  - Show last winner
- **Files**: `src/bot/commands/raffle.ts`

### T-015: Admin commands
- Create `src/bot/commands/admin.ts`:
  - `/admin volume` — Volume stats
  - `/admin swaps` — Recent swaps list
  - `/admin users` — Active users count
  - `/admin fee` — Change commission rate
  - `/admin broadcast` — Message all users
  - `/admin raffle` — Manual draw, status
  - Admin authorization guard
- **Files**: `src/bot/commands/admin.ts`

## Phase 5: Polish

### T-016: Message templates
- Create `src/bot/messages.ts`:
  - All user-facing messages in Spanish (primary)
  - English support via i18n
  - Emoji-rich formatting
  - Inline keyboard builders
- **Files**: `src/bot/messages.ts`

### T-017: Rate limiting
- Create `src/bot/middleware/rate-limit.ts`:
  - Limit: 10 messages/minute per user
  - Burst: 3 messages/second
  - Graceful throttle message
- **Files**: `src/bot/middleware/rate-limit.ts`

### T-018: Error middleware
- Create `src/bot/middleware/error.ts`:
  - Global error handler
  - Sentry-like logging
  - User-friendly error messages
  - Admin alert on critical errors
- **Files**: `src/bot/middleware/error.ts`

### T-019: Unit tests
- Create `tests/unit/commission.test.ts`
- Create `tests/unit/raffle.test.ts`
- Create `tests/unit/boltz-client.test.ts`
- Mock Boltz API responses
- Test edge cases: min/max amounts, rate changes, failures
- **Files**: `tests/unit/*.test.ts`

### T-020: Integration tests
- Create `tests/integration/swap-flow.test.ts`
- Test full swap lifecycle with mocked Boltz
- Test error scenarios
- Test concurrent swaps
- **Files**: `tests/integration/swap-flow.test.ts`

### T-021: GitHub setup
- Create `.gitignore`
- Create `README.md` with setup instructions
- Create `CONTRIBUTING.md`
- Create GitHub Actions CI workflow
- Create GitHub repo and push
- **Files**: `.gitignore`, `README.md`, `CONTRIBUTING.md`, `.github/workflows/ci.yml`
