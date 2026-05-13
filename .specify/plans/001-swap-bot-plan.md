---
id: "001"
spec: "001-swap-bot-core.md"
version: "1.0.0"
created: "2026-05-13"
---

# Telegram Swap Bot — Implementation Plan

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Telegram Bot (Node.js)                     │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Telegraf     │  │ Swap Engine  │  │ Commission       │  │
│  │ Handlers     │──│ (Boltz       │──│ Engine           │  │
│  │ /start       │  │  Client)     │  │ (2.5% + Raffle)  │  │
│  │ /swap        │  │              │  │                  │  │
│  │ /rates       │  │ - POST swap  │  │ - Calculate fee  │  │
│  │ /raffle      │  │ - WS listen  │  │ - Weekly draw   │  │
│  │ /admin.*     │  │ - Status     │  │ - Payout        │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                 │                   │             │
└─────────┼─────────────────┼───────────────────┼─────────────┘
          │                 │                   │
     Telegram API      Boltz API v2         MongoDB
                    (HTTPS + WSS)
```

## Directory Structure

```
telegram-swap-bot/
├── src/
│   ├── index.ts              # Entry point
│   ├── bot/
│   │   ├── bot.ts            # Telegraf init + middleware
│   │   ├── commands/
│   │   │   ├── start.ts      # /start handler
│   │   │   ├── swap.ts       # /swap flow
│   │   │   ├── rates.ts      # /rates display
│   │   │   ├── raffle.ts     # /raffle info
│   │   │   ├── help.ts       # /help
│   │   │   └── admin.ts      # /admin.* commands
│   │   ├── middleware/
│   │   │   ├── rate-limit.ts
│   │   │   ├── user.ts       # User tracking middleware
│   │   │   └── error.ts      # Error handler
│   │   └── messages.ts       # All message templates
│   ├── boltz/
│   │   ├── client.ts         # Boltz HTTP client
│   │   ├── types.ts          # Boltz API types
│   │   ├── swap.ts           # Swap orchestration
│   │   └── websocket.ts      # WebSocket subscription manager
│   ├── engine/
│   │   ├── commission.ts     # Fee calculation
│   │   ├── raffle.ts         # Weekly raffle logic
│   │   └── rates.ts          # Rate fetching + markup
│   ├── models/
│   │   ├── User.ts           # Mongoose User schema
│   │   ├── Swap.ts           # Mongoose Swap schema
│   │   └── Raffle.ts         # Mongoose Raffle schema
│   ├── jobs/
│   │   ├── raffle-draw.ts    # Weekly raffle scheduler
│   │   └── swap-cleanup.ts   # Stale swap cleanup
│   └── utils/
│       ├── logger.ts         # Winston logger
│       ├── config.ts         # Env config
│       └── helpers.ts        # Formatting, validation
├── tests/
│   ├── unit/
│   │   ├── commission.test.ts
│   │   ├── raffle.test.ts
│   │   └── boltz-client.test.ts
│   └── integration/
│       └── swap-flow.test.ts
├── .env-sample
├── package.json
├── tsconfig.json
└── .eslintrc.json
```

## Implementation Phases

### Phase 1: Foundation (Days 1-2)
- [ ] Project scaffold: package.json, tsconfig, eslint
- [ ] MongoDB connection + models
- [ ] Logger + config
- [ ] Telegraf bot skeleton with /start
- [ ] User middleware (track users)

### Phase 2: Boltz Integration (Days 3-5)
- [ ] Boltz HTTP client (GET pairs, POST swap)
- [ ] WebSocket subscription manager
- [ ] Swap orchestration: create → monitor → complete
- [ ] Error handling: timeouts, failures, refunds
- [ ] Rate fetching + markup calculation

### Phase 3: Swap Flow (Days 6-8)
- [ ] /swap command with direction selection
- [ ] Amount input with validation
- [ ] Fee breakdown display (Boltz + bot commission)
- [ ] Confirmation flow
- [ ] Execution + monitoring
- [ ] Completion notification

### Phase 4: Admin & Raffle (Days 9-10)
- [ ] /rates command
- [ ] /raffle command + weekly scheduler
- [ ] /admin commands (volume, swaps, users, fee, broadcast)
- [ ] Weekly raffle draw automation
- [ ] Raffle payout via Lightning

### Phase 5: Polish (Days 11-12)
- [ ] Rate limiting middleware
- [ ] Error messages in Spanish + English
- [ ] Promotional 0.1% raffle weekly
- [ ] Testing (unit + integration)
- [ ] Deployment documentation

## API Routes (Boltz)

### Submarine Swap (USDT → BTC/Lightning)
```
POST /v2/swap/submarine
Body: { invoice, from: "USDT", to: "BTC", refundPublicKey }
Response: { id, address, expectedAmount, rate, ... }
```

### Reverse Swap (BTC/Lightning → USDT)
```
POST /v2/swap/reverse
Body: { invoiceAmount, from: "BTC", to: "USDT", claimPublicKey, preimageHash }
Response: { id, invoice, lockupAddress, ... }
```

### WebSocket
```
WS /v2/ws
Send: { op: "subscribe", channel: "swap.update", args: [swapId] }
Receive: { event: "update", args: [{ status, ... }] }
```

## Commission Calculation

```
sourceAmount = 1000 USDT
botRate = 2.5%
boltzRate = 0.5%

botCommission = sourceAmount * (botRate / 100) = 25 USDT
boltzCommission = (sourceAmount - botCommission) * (boltzRate / 100) = 4.875 USDT
netToSwap = sourceAmount - botCommission - boltzCommission = 970.125 USDT
```

## Weekly Raffle Algorithm

```
every Sunday 23:59 UTC:
  1. Calculate prizePool = totalSwapVolume * 0.001 (0.1%)
  2. Get all users who swapped this week
  3. Weight by swapsCount (more swaps = more tickets)
  4. Random selection weighted by tickets
  5. Create Lightning invoice for winner amount
  6. Pay via Boltz reverse swap
  7. Log winner, amount, tx hash
  8. Reset weekly counters
```

## Key Dependencies

```json
{
  "telegraf": "^4.x",
  "mongoose": "^8.x",
  "axios": "^1.x",
  "ws": "^8.x",
  "node-schedule": "^2.x",
  "winston": "^3.x",
  "dotenv": "^16.x",
  "boltz-core": "^3.x"
}
```
