---
id: "002"
title: "Swap Bot v2 — USDT/USDC pairs + Boltz Pro Liquidity"
status: "draft"
version: "2.0.0"
created: "2026-05-13"
---

# Telegram Swap Bot v2 — USDT/USDC + Boltz Pro

## Overview

Phase 2 of the Swap Bot adds cross-currency swaps (USDT/USDC ↔ BTC/Lightning) via Boltz API and integrates Boltz Pro liquidity provision for additional yield on bot treasury.

## 1. Restore USDT/USDC Swap Pairs

### Current State
- Bot only supports BTC on-chain ↔ Lightning
- Boltz public API v2 pairs endpoint shows BTC/L-BTC/RBTC/TBTC/ARK only
- Boltz Web App shows USDT pairs (via USDT0/Arbitrum)

### Investigation Required
- USDT swaps on Boltz use `boltz-core` TypeScript library (supports USDT)
- May require different API endpoint or pair discovery method
- USDT0 operates on Arbitrum and other EVM chains via LayerZero

### Implementation Approach
A) **Try Boltz API directly**: POST swap with `from: 'USDT', to: 'BTC'` even if not listed in GET pairs
B) **Use boltz-core library**: `npm install boltz-core` for full TypeScript swap support
C) **Fallback gracefully**: If pairs not available, show "coming soon" to user
D) **Multi-currency detection**: Auto-detect available pairs and show only what's live

### Supported Directions (when available)
| From | To | Network | Swap Type |
|---|---|---|---|
| USDT (USDT0) | BTC (Lightning) | Arbitrum → LN | Submarine |
| BTC (Lightning) | USDT (USDT0) | LN → Arbitrum | Reverse |
| USDC (USDT0) | BTC (Lightning) | Arbitrum → LN | Submarine |
| BTC (Lightning) | USDC (USDT0) | LN → Arbitrum | Reverse |
| BTC (On-chain) | BTC (Lightning) | Mainnet → LN | Submarine |
| BTC (Lightning) | BTC (On-chain) | LN → Mainnet | Reverse |

## 2. Boltz Pro — Liquidity Provision

### What is Boltz Pro?
Boltz Pro lets users provide BTC liquidity to help Boltz manage wallet balances and Lightning channel liquidity. In exchange, the liquidity provider earns BTC from swap fees.

### How It Works
- User deposits BTC into Boltz Pro
- Boltz uses the funds to facilitate swaps
- Provider earns yield proportional to their share
- Non-custodial: funds are in a multi-sig or managed pool

### Integration for SwapBot
The bot's treasury BTC can be deployed to Boltz Pro:
1. Accumulated commissions in BTC → deploy to Boltz Pro
2. Earn additional yield on idle treasury
3. Admin command to manage: deposit / withdraw / check yield

### New Admin Commands
```
/admin pro status    → Current yield, APY, total deployed
/admin pro deposit   → Deploy treasury BTC to Boltz Pro
/admin pro withdraw  → Withdraw from Boltz Pro to treasury
```

### Prerequisites
- Boltz Pro account (https://pro.boltz.exchange)
- BTC to deploy as liquidity
- Boltz Pro API integration (if available)

## 3. Features List

### Swap Enhancements
- [ ] USDT/USDC pair auto-detection from Boltz API
- [ ] Multi-currency swap menu in Telegram
- [ ] Cross-currency rate calculation (USDT→BTC rate)
- [ ] Graceful fallback when pairs unavailable

### Boltz Pro Integration
- [ ] Boltz Pro API client
- [ ] Treasury ↔ Pro deposit/withdraw flow
- [ ] Yield tracking and display
- [ ] Admin commands for Pro management

### UX Improvements
- [ ] Async swap execution with live status via WebSocket
- [ ] Real-time swap progress indicator
- [ ] Error handling with clear next steps
- [ ] Swap history for users (/myswaps)

## 4. Technical Architecture

```
┌─────────────────────────────────────┐
│           Telegram Bot              │
│                                      │
│  ┌───────────┐  ┌────────────────┐  │
│  │ Swap Flow │  │ Pro Manager    │  │
│  │           │  │                │  │
│  │ BTC/LN    │  │ - Deposit      │  │
│  │ USDT/BTC  │  │ - Withdraw     │  │
│  │ USDC/BTC  │  │ - Yield Stats  │  │
│  └─────┬─────┘  └───────┬────────┘  │
│        │                │           │
└────────┼────────────────┼───────────┘
         │                │
    ┌────▼────┐      ┌────▼──────┐
    │ Boltz   │      │ Boltz Pro │
    │ API v2  │      │ API       │
    │ (swaps) │      │ (yield)   │
    └─────────┘      └───────────┘
```

## 5. Implementation Phases

### Phase 6A: USDT/USDC Pair Research (Day 1)
- [ ] Research: try Boltz API with USDT pairs directly
- [ ] Test with regtest/boltz-backend local instance
- [ ] Document findings, update types if needed

### Phase 6B: Multi-Currency Swap (Days 2-3)
- [ ] Update swap direction mapping
- [ ] Dynamic pair discovery from API
- [ ] Fallback logic for missing pairs
- [ ] Update rate engine for cross-currency rates
- [ ] Update commission engine for multi-currency

### Phase 6C: Boltz Pro Integration (Days 4-5)
- [ ] Research Boltz Pro API (if available)
- [ ] Create Pro module in src/boltz/pro.ts
- [ ] Admin commands for Pro management
- [ ] Yield tracking and display
- [ ] Treasury auto-deploy option

### Phase 6D: UX Polish (Days 6-7)
- [ ] Live swap status via WebSocket
- [ ] Swap history endpoint
- [ ] Better error messages
- [ ] /myswaps command
- [ ] Deployment and testing
