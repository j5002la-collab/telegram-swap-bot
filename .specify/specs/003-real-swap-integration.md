---
id: "003"
title: "Real Swap Integration via Boltz API v2"
status: "draft"
version: "3.0.0"
created: "2026-05-13"
based_on: "https://api.docs.boltz.exchange/"
---

# Real Swap Integration — Boltz API v2 Live

## Objetivo
Conectar el bot a Boltz API v2 para ejecutar swaps reales no-custodiales.
Eliminar la simulacion actual. Sin necesidad de coordinar firma (MuSig2) —
Boltz hara el script-path claim automaticamente.

## API Endpoints Relevantes

| Endpoint | Metodo | Proposito |
|---|---|---|
| `/v2/swap/submarine` | GET | Pares disponibles + fees |
| `/v2/swap/submarine` | POST | Crear submarine swap (Chain → LN) |
| `/v2/swap/reverse` | GET | Pares disponibles reverse |
| `/v2/swap/reverse` | POST | Crear reverse swap (LN → Chain) |
| `/v2/swap/submarine/{id}/claim` | GET | Detalles para firma cooperativa |
| `/v2/swap/submarine/{id}/claim` | POST | Enviar firma parcial |
| `/v2/ws` | WebSocket | Suscribirse a updates de swap |

## Submarine Swap — Flujo (BTC On-chain → Lightning)

Basado en el ejemplo oficial de Boltz:
```
POST /v2/swap/submarine
Body: { invoice, from: "BTC", to: "BTC", refundPublicKey }

Response:
{
  id: "abc123",
  address: "bc1q...",          ← DONDE el usuario envia sus BTC
  expectedAmount: 100000,       ← Cuanto debe enviar exactamente
  claimPublicKey: "02...",
  swapTree: {...},
  timeoutBlockHeight: 850000
}
```

### Estados (via WebSocket)
| Estado | Significa | Mensaje al usuario |
|---|---|---|
| `swap.created` | Swap creado, esperando pago | "Envia X sats a bc1q..." |
| `invoice.set` | Invoice validada | — |
| `transaction.mempool` | Tx detectada en mempool | "Tx detectada, esperando confirmacion" |
| `transaction.confirmed` | 1 conf | "Confirmada. Boltz esta pagando tu invoice" |
| `transaction.claim.pending` | Boltz listo para claim | "Swap casi listo..." |
| `transaction.claimed` | **Completado** ✅ | "Swap completado!" |
| `invoice.failedToPay` | Fallo ❌ | "Error: Boltz no pudo pagar tu invoice" |
| `swap.expired` | Timeout | "Expiro. Tus fondos seran reembolsados" |

### IMPORTANTE: Cooperative Claim (OPCIONAL)
Boltz docs muestran firma Musig2. **NO es obligatorio**. Si no enviamos firma,
Boltz reclama via script-path (gasta mas gas pero funciona igual).
Para v1 del bot, **no implementamos firma cooperativa**.
El swap tarda un poco mas pero es seguro.

## Reverse Swap — Flujo (Lightning → BTC On-chain)

```
POST /v2/swap/reverse
Body: { invoiceAmount, from: "BTC", to: "BTC", claimPublicKey, preimageHash }

Response:
{
  id: "xyz789",
  invoice: "lnbc...",           ← Invoice que el usuario debe pagar
  lockupAddress: "bc1q...",     ← Donde Boltz lockea los BTC
  expectedAmount: 98000,
  timeoutBlockHeight: 851000
}
```

### Estados
| Estado | Significa | Mensaje |
|---|---|---|
| `swap.created` | Esperando pago LN | "Paga esta invoice: lnbc..." |
| `transaction.mempool` | Boltz lockeo on-chain | "Boltz lockeo fondos en la chain" |
| `transaction.confirmed` | Lock confirmado | — |
| `invoice.settled` | **Completado** ✅ | "Swap completado!" |
| `invoice.expired` | Invoice LN expiro | "Invoice expiro, intenta de nuevo" |
| `swap.expired` | Timeout | "Expiro. Reintenta con /swap" |

## Que NO necesita el bot (para v1)

La documentacion de Boltz muestra codigo complejo para:
- **Firma Musig2** → NO lo necesitamos. Boltz hace script-path claim.
- **Validacion de swapTree** → NO para v1. Confiamos en Boltz.
- **Construir claim transaction** → NO. El usuario solo envia/recibe.

Esto simplifica MASSIVAMENTE la integracion. El bot solo necesita:
1. Llamar al endpoint POST correcto
2. Conectarse al WebSocket
3. Actualizar al usuario en cada cambio de estado

## Implementacion

### T-034: Real swap orchestrator (src/boltz/swap.ts)
- `executeSubmarineSwap()` → POST /v2/swap/submarine
- `executeReverseSwap()` → POST /v2/swap/reverse
- `monitorSwap()` → WebSocket subscribe + status updates
- `handleSwapCompletion()` → guardar en DB + treasury + raffle
- `handleSwapFailure()` → instrucciones de refund/timeout

### T-035: WebSocket status → Telegram messages
- Mapear cada BoltzSwapStatus a un mensaje de usuario
- Editar mensaje en Telegram en cada cambio (no enviar nuevo)
- Timeout 30 minutos → `swap.expired`

### T-036: Submarine flow completo
1. User ingresa invoice Lightning + monto
2. Bot → `POST /v2/swap/submarine` con la invoice
3. Bot muestra address de Boltz: "Envia X sats a esta direccion"
4. User envia desde su wallet externa
5. Bot monitorea WebSocket
6. Notifica en cada paso
7. Completado → guarda + tracking

### T-037: Reverse flow completo
1. User selecciona monto + destino
2. Bot → `POST /v2/swap/reverse`
3. Bot muestra invoice LN: "Paga esta invoice"
4. User paga desde su wallet Lightning
5. Bot monitorea WebSocket
6. Notifica en cada paso
7. Completado → guarda + tracking

### T-038: Error handling
- API caida → retry 3x con backoff
- Invoice invalida → mensaje claro
- Amount fuera de rango → min/max
- Timeout → refund instructions

### T-039: Testing en mainnet
- Probar con montos pequenos (50,000 sats)
- 1 swap submarine (BTC→LN)
- 1 swap reverse (LN→BTC)
- Verificar que WebSocket funciona
- Verificar que DB guarda correctamente
