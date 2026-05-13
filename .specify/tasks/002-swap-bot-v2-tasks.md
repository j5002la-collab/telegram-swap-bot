---
id: "002"
plan: "002-swap-bot-v2-plan.md"
version: "2.0.0"
created: "2026-05-13"
---

# Swap Bot v2 — Tasks

## Phase 6A: USDT/USDC Research

### T-022: Research USDT pairs on Boltz (2h)
- [ ] Query `POST /v2/swap/submarine` with from=USDT, to=BTC directly
- [ ] Query `POST /v2/swap/chain` with from=USDT, to=BTC 
- [ ] Check Boltz Web App source for USDT pair logic
- [ ] Check boltz-core library for USDT swap support
- [ ] Document findings in docs/USDT-PAIRS-RESEARCH.md

### T-023: Update Boltz types (1h)
- [ ] Add USDT/USDC to BoltzCurrency union type
- [ ] Update SubmarineSwapRequest to accept USDT/USDC
- [ ] Add cross-currency rate field
- [ ] Type-safe from/to pair validation

## Phase 6B: Multi-Currency Swap (3 days)

### T-024: Dynamic pair discovery (3h)
- [ ] Refactor getRate() to try all 3 endpoints
- [ ] getAvailablePairs() returns live pairs only
- [ ] Cache with 5 min TTL per swap type
- [ ] Graceful fallback when endpoint fails

### T-025: Restore USDT/USDC swap directions (3h)
- [ ] Add USDT/USDC to DIRECTION_MAP
- [ ] Dynamic keyboard: show only available pairs
- [ ] Show BTC pairs as always-available fallback
- [ ] Handle SwapDirection enum in models

### T-026: Cross-currency rates (2h)
- [ ] Parse rate from Boltz pair response
- [ ] Calculate USDT equivalent in sats
- [ ] Display both currencies in fee breakdown
- [ ] Handle rate changes during swap

### T-027: Update /rates display (1h)
- [ ] Add USDT rows when pairs available
- [ ] Show "No disponible" when not
- [ ] Refresh logic with new pairs
- [ ] Rate format for cross-currency (not 1:1)

## Phase 6C: Boltz Pro (2 days)

### T-028: Research Boltz Pro (2h)
- [ ] Check https://pro.boltz.exchange for API docs
- [ ] Check if Boltz Pro has public REST API
- [ ] Document minimum deposit, yield model
- [ ] Document withdrawal process

### T-029: Boltz Pro module (3h)
- [ ] Create src/boltz/pro.ts if API exists
- [ ] getProStatus() — deployed amount, yield
- [ ] getProHistory() — yield payouts
- [ ] Connect to existing BoltzClient infrastructure

### T-030: Admin Pro commands (2h)
- [ ] /admin pro status — display yield info
- [ ] /admin pro deposit — manual trigger
- [ ] /admin pro withdraw — manual trigger
- [ ] Pro balance tracking in treasury

## Phase 6D: UX Polish (2 days)

### T-031: Live swap status WebSocket (3h)
- [ ] Subscribe to swap updates on execution
- [ ] Update Telegram message with progress
- [ ] Clear completion/failure messages
- [ ] Timeout handling (30 min)

### T-032: /myswaps command (2h)
- [ ] Query last 10 swaps for user
- [ ] Display: date, direction, amount, status
- [ ] Pagination with inline buttons
- [ ] Link to swap details

### T-033: Testing and deploy (3h)
- [ ] End-to-end test all swap directions
- [ ] Test with small amounts on mainnet
- [ ] Test error scenarios
- [ ] Update DEPLOY.md
- [ ] Tag release v2.0.0
