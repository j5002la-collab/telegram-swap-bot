---
id: "001"
title: "Swap Bot — Core Swap Flow"
status: "draft"
version: "1.0.0"
created: "2026-05-13"
---

# Telegram Swap Bot — Core Specification

## Overview

A Telegram bot that lets users swap USDT/USDC ↔ BTC/Lightning instantly. The bot uses Boltz API v2 as the swap backend, takes a 2.5%-3% commission, and runs a weekly 0.1% raffle for promotion. No P2P marketplace, no order books, no custody of funds.

## User Flow

### 1. Start
User sends `/start` to the bot.

**Bot responds:**
```
🤖 SwapBot — Cambios USDT ↔ BTC

/swap  Iniciar un swap
/rates Ver tasas actuales
/raffle Ver sorteo semanal
/help Ayuda
```

### 2. Initiate Swap — `/swap`
User sends `/swap`.

**Bot asks:**
```
¿Qué quieres convertir?

[ USDT → BTC ]    [ BTC → USDT ]
[ USDC → BTC ]    [ BTC → USDC ]
```

### 3. Enter Amount
After selecting direction, bot asks for amount.

**Bot:**
```
¿Cuánto quieres convertir?

Monto mínimo: 25,000 sats (~$20 USD)
Monto máximo: 25,000,000 sats (~$20,000 USD)
```

### 4. Fee Breakdown
Before confirming, bot shows full breakdown.

**Bot:**
```
📋 Resumen de tu swap

Convertir: 1,000 USDT → BTC
Tasa: 1 USDT = 2,345 sats

Comisiones:
  ├── Boltz (0.5%): 5 USDT
  └── SwapBot (2.5%): 25 USDT

Recibirás: ~2,274,150 sats (~$970 USD)
Tiempo estimado: 1-5 minutos

[ ✅ Confirmar ]    [ ❌ Cancelar ]
```

### 5. Execute Swap
User confirms. Bot orchestrates the swap via Boltz API.

**Flow:**
```
a. Bot calls POST /v2/swap/submarine (or reverse/chain)
b. Bot subscribes to WebSocket for swap updates
c. Bot sends Boltz address/invoice to user
d. User sends funds to Boltz address
e. Bot monitors status via WebSocket
f. On success: Bot notifies user
g. On failure: Bot provides refund instructions
```

### 6. Completion

**Bot:**
```
✅ ¡Swap completado!

1,000 USDT → 2,274,150 sats
Tiempo: 2 minutos

Comisión SwapBot: 25 USDT
ID: SWAP-ABC123
```

## Swap Directions Supported

| From | To | Boltz Swap Type |
|---|---|---|
| USDT (USDT0/Arbitrum) | BTC (Lightning) | Submarine |
| BTC (Lightning) | USDT (USDT0/Arbitrum) | Reverse |
| USDC (USDT0/Arbitrum) | BTC (Lightning) | Submarine |
| BTC (Lightning) | USDC (USDT0/Arbitrum) | Reverse |
| USDT | USDC | No swap (same price) |
| BTC (Lightning) | BTC (On-chain) | Submarine |

## Commission Engine

### Standard Commission
- **Rate**: 2.5% (configurable up to 3%)
- **Applied on**: Source amount (before Boltz fees)
- **Minimum**: 5,000 sats equivalent (~$4 USD)

### Weekly Raffle — 0.1%
- **Prize pool**: 0.1% of total swap volume that week
- **Winner selection**: Random weighted by number of swaps done that week
- **Draw**: Every Sunday 23:59 UTC
- **Payout**: Automatically sent to winner's Lightning wallet
- **Transparency**: All draws logged, verifiable hash chain

### Example: Week 1
```
Total volume: $50,000
Prize pool: $50 (0.1%)
Users participated: 120
Winner gets: ~60,000 sats
```

## Rate Display

Bot fetches rates from Boltz API (no external oracle needed):
- Boltz `/v2/swap/submarine` returns `rate` field
- Bot adds commission markup
- Displays final rate to user

## Error Handling

| Scenario | Bot Response |
|---|---|
| Boltz API down | "Servicio temporalmente no disponible. Intenta en 5 minutos." |
| Swap expired | Te mostramos instrucciones de reembolso de Boltz |
| Amount outside limits | Te mostramos el mínimo y máximo permitido |
| Invoice invalid | "Factura inválida. Asegúrate de que sea una factura Lightning válida." |
| Rate changed | "La tasa cambió. ¿Quieres confirmar con la nueva tasa?" |

## Admin Commands

| Command | Description |
|---|---|
| `/admin volume` | Total volume today/week/month |
| `/admin swaps` | Recent swaps (last 20) |
| `/admin users` | Active users count |
| `/admin raffle` | Raffle status, draw now |
| `/admin fee` | Change commission rate |
| `/admin broadcast` | Send message to all users |

## Data Model

```
User {
  telegramId: string
  username: string
  firstSeen: timestamp
  swapsCount: number
  totalVolume: number (USD)
  raffleTickets: number  // swaps this week
}

Swap {
  id: string
  userId: string
  direction: string  // "USDT→BTC", "BTC→USDT", etc.
  sourceAmount: number
  destAmount: number
  sourceCurrency: string
  destCurrency: string
  boltzSwapId: string
  boltzStatus: string
  commissionRate: number
  commissionAmount: number
  botProfit: number
  status: string  // pending, completed, failed, refunded
  createdAt: timestamp
  completedAt: timestamp
}

Raffle {
  id: string
  weekNumber: number
  prizePool: number
  totalVolume: number
  participants: number
  winnerId: string
  winnerUsername: string
  drawAt: timestamp
  paid: boolean
  txHash: string
}
```

## Performance Requirements

- Bot response time: < 2 seconds for messages
- Swap status updates: Real-time via WebSocket
- Concurrent users: Support 1,000+ without degradation
- Uptime: 99.5% (excluding Boltz downtime)
