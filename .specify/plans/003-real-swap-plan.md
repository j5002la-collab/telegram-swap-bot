---
id: "003"
spec: "003-real-swap-integration.md"
version: "3.0.0"
created: "2026-05-13"
---

# Real Swap Integration — Implementation Plan

## Phase 7A: Real Swap Orchestrator

### T-034: Connect swap.ts to real Boltz API
- Replace simulated swap with `boltzClient.createSubmarineSwap()` and `createReverseSwap()`
- Store real `boltzSwapId` in database
- Generate proper keys (using bitcoinjs-lib or random hex)
- **Files**: `src/boltz/swap.ts`, `src/bot/commands/swap.ts`

### T-035: WebSocket live status monitoring
- Subscribe to `swap.update` channel on swap creation
- Handle all status transitions (see lifecycle)
- Auto-reconnect on WebSocket disconnect
- **Files**: `src/boltz/websocket.ts`, `src/boltz/swap.ts`

### T-036: Handle all swap states
- Map each BoltzSwapStatus to user message
- `swap.created` → "Esperando pago..."
- `transaction.mempool` → "Tx detectada"
- `transaction.confirmed` → "Confirmada"
- `invoice.paid` → "Invoice pagada"
- `transaction.claimed` → "Completado!"
- `swap.expired` → "Expiro, fondos reembolsados"
- `invoice.failedToPay` → "Fallo el pago"
- **Files**: `src/boltz/swap.ts`

### T-037: Timeout and refund flow
- 30-minute timeout per swap
- Generate refund transaction instructions
- Store refund info in database
- Notify user on timeout
- **Files**: `src/boltz/swap.ts`

## Phase 7B: User Flow

### T-038: Live swap progress messages
- Update Telegram message on each status change
- Show progress indicator (emoji per state)
- Clear on completion
- **Files**: `src/bot/commands/swap.ts`

### T-039: Submarine swap flow
- User provides Lightning invoice
- Bot creates swap → shows BTC address to send to
- User sends from external wallet
- Bot monitors → completes
- **Files**: `src/bot/commands/swap.ts`

### T-040: Reverse swap flow
- User enters amount
- Bot creates swap → shows LN invoice to pay
- User pays from Lightning wallet
- Bot monitors → completes
- **Files**: `src/bot/commands/swap.ts`

## Phase 7C: Error Handling

### T-041: Boltz API error handling
- Connection errors → retry with backoff
- Invalid invoice → user-friendly message
- Pair not found → fallback options
- **Files**: `src/boltz/client.ts`, `src/bot/commands/swap.ts`

### T-042: Rate change detection
- Compare rate at creation vs confirmation
- Show warning if rate changed significantly
- Allow user to accept new rate or cancel
- **Files**: `src/engine/rates.ts`

### T-043: End-to-end testing
- Test on Boltz regtest
- Test all swap types
- Test error scenarios
- Test WebSocket reconnection
- **Files**: `tests/integration/`

### T-044: Production deploy
- Update DEPLOY.md with testing instructions
- Minimum test amounts (5000 sats)
- Rollback procedure
- Monitor first 10 swaps manually
