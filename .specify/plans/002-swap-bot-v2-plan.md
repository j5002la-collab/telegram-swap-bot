---
id: "002"
spec: "002-swap-bot-v2.md"
version: "2.0.0"
created: "2026-05-13"
---

# Swap Bot v2 — Implementation Plan

## Phase 6A: USDT/USDC Pair Research

### T-022: Research USDT pairs on Boltz
- Query Boltz API with `from: 'USDT'` directly (even if not in GET pairs)
- Check if pairs require special API key or configuration
- Test with Boltz regtest instance
- Document which `from`/`to` combinations work
- **Files**: research notes in `docs/USDT-PAIR-RESEARCH.md`

### T-023: Update Boltz types for USDT
- Add USDT/USDC to `BoltzCurrency` type
- Add cross-currency swap examples to types.ts
- Add rate calculation for non-1:1 pairs (USDT→BTC uses market rate)
- **Files**: `src/boltz/types.ts`

## Phase 6B: Multi-Currency Swap

### T-024: Dynamic pair discovery
- Refactor `rateEngine.getRate()` to handle unknown pairs gracefully
- Add `getAvailablePairs()` that queries all 3 swap types
- Filter display pairs to only what's available live
- Cache available pairs (5 min TTL)
- **Files**: `src/engine/rates.ts`

### T-025: Restore USDT/USDC swap directions
- Add USDT/USDC directions back to `DIRECTION_MAP` in swap.ts
- Show them ONLY if pairs are available from API
- Fallback: show BTC pairs if USDT unavailable
- **Files**: `src/bot/commands/swap.ts`

### T-026: Cross-currency rate calculation
- For USDT→BTC: need external rate oracle (Boltz provides `rate` field)
- Convert USDT amount to sats equivalent using rate
- Display both source and destination amounts
- **Files**: `src/engine/rates.ts`

### T-027: Update rate display
- Add USDT/USDC rows back to `/rates` when pairs available
- Show rate with proper decimal precision
- Handle "pair unavailable" state gracefully
- **Files**: `src/bot/commands/rates.ts`

## Phase 6C: Boltz Pro Integration

### T-028: Research Boltz Pro
- Investigate https://pro.boltz.exchange API
- Document: does it have a public API?
- Document: minimum deposit, yield rates, withdrawal process
- **Files**: `docs/BOLTZ-PRO-RESEARCH.md`

### T-029: Boltz Pro module
- Only if API exists: create `src/boltz/pro.ts`
- Connect to Boltz Pro with existing BoltzClient
- Methods: getStatus(), getYield(), getHistory()
- **Files**: `src/boltz/pro.ts`

### T-030: Admin Pro commands
- `/admin pro status` — current yield, APY, deployed amount
- `/admin pro deposit` — deploy treasury to Pro (manual trigger)
- Tracks Pro balance separately from treasury
- **Files**: `src/bot/commands/admin.ts`

## Phase 6D: UX Polish

### T-031: Live swap status via WebSocket
- Use existing BoltzWebSocket for real-time updates
- Show progress to user: created → mempool → confirmed → completed
- Handle failure states with clear instructions
- **Files**: `src/boltz/websocket.ts`, `src/bot/commands/swap.ts`

### T-032: Swap history command
- `/myswaps` — user's last 10 swaps
- Show date, direction, amount, status
- Pagination with inline buttons
- **Files**: `src/bot/commands/swap.ts`

### T-033: Final testing and deploy
- End-to-end test with real Boltz API
- Test all swap directions
- Test error scenarios
- Update DEPLOY.md with v2 notes
