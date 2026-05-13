# Telegram Swap Bot — Constitution

## Core Principles

### I. Telegram-First UX
The bot is purely a Telegram interface for atomic swaps. No web UI, no mobile app. Every interaction happens through Telegram inline keyboards, commands, and direct messages. The user experience must feel like chatting with a person, not a terminal.

### II. Non-Custodial by Design
The bot NEVER holds user funds. All swaps route through Boltz API v2 using atomic swap technology. The bot is purely an intermediary that facilitates the swap and takes a commission. No private keys, no wallets, no balances.

### III. Commission Model
Core revenue is 2.5%-3% per swap. Weekly 0.1% raffle as promotion. Commissions are calculated on the source amount before Boltz fees. Transparent breakdown shown to user before confirming any swap.

### IV. Simplicity Over Features
No P2P marketplace. No order books. No disputes. No communities. Just: paste invoice → choose swap → confirm → done. The value proposition is simplicity and speed. Features that add complexity must prove their value first.

### V. Observability
Every swap is logged with: timestamp, user, amounts, fees, Boltz swap ID, status. Failed swaps trigger alerts. Weekly raffle is automated and verifiable. Runbook for manual intervention defined.

## Technology Stack

| Layer | Technology |
|---|---|
| **Bot Framework** | Telegraf (Node.js) + TypeScript |
| **Swap Engine** | Boltz API v2 (REST + WebSocket) |
| **Database** | MongoDB (Mongoose) |
| **Scheduling** | node-schedule |
| **Logging** | Winston |
| **Config** | dotenv |
| **Testing** | Mocha + Chai |
| **Linting** | ESLint + Prettier |

## Security Requirements

- All Boltz API calls use HTTPS/wss
- User Telegram IDs are the only identity — no emails, no KYC
- Commission addresses are hardcoded environment variables
- Boltz refund keys generated per-swap and discarded after completion
- Rate limiting on all commands (anti-spam)
- Swap amounts bounded by Boltz pair limits (min/max)

## Development Workflow

1. Specifications define the "what" — reviewed and approved before coding
2. Plans define the "how" — reviewed before implementation
3. Tasks are granular (≤1 day each)
4. Each feature branch → spec → plan → tasks → implement → test → PR
5. Unit tests required for: commission calculation, Boltz API client, raffle logic
6. Integration tests required for: full swap flow (regtest), error handling

## Governance

- Constitution supersedes ad-hoc decisions
- Amendments require documented rationale and migration plan
- Commission rates changes require user notification (Telegram broadcast)
- Raffle logic changes require smart contract audit or equivalent transparency

**Version**: 1.0.0 | **Ratified**: 2026-05-13
