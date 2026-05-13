---
id: "004"
title: "FixedFloat Integration — USDT/USDC Multi-Network Swaps"
status: "draft"
version: "4.0.0"
created: "2026-05-13"
based_on: "https://ff.io/api"
---

# FixedFloat — USDT/USDC ↔ BTC/Lightning

## Descubrimiento

FixedFloat expone pares USDT/USDC → BTC/BTCLN vivos HOY.
Rates públicos sin auth: `https://ff.io/rates/float.xml`

### Pares Confirmados (Live)

| From | To | Min | Max |
|---|---|---|---|
| USDTTRC | BTC | ~$11 | ~$143k |
| USDTTRC | BTCLN | ~$10 | ~$14k |
| USDT (ERC-20) | BTC | ~$10 | ~$143k |
| USDT (ERC-20) | BTCLN | — | — |
| USDTBSC | BTC | ~$10 | ~$143k |
| USDTARBITRUM | BTCLN | ~$2 | ~$14k |
| USDCETH | BTC | ~$10 | ~$143k |
| USDCETH | BTCLN | ~$22 | ~$14k |
| BTC | USDTTRC | 0.0013 BTC | 1.69 BTC |
| BTCLN | USDTTRC | 0.00013 BTC | 1.69 BTC |

**Todas las redes:** TRC-20, ERC-20, BEP-20, Arbitrum, Polygon, Solana, Avalanche, Base, Optimism

## Diferencias con Boltz

| | Boltz | FixedFloat |
|---|---|---|
| Custodia | No-custodial (atomic swap) | Custodial (confías en FF) |
| Pares | Solo BTC layers | 100+ pares incl USDT/USDC |
| Auth | API pública | API Key + HMAC-SHA256 |
| Rates | `GET /v2/swap/submarine` | `GET /rates/float.xml` (público!) |
| Create swap | `POST /v2/swap/submarine` | `POST /api/v2/create` |
| Monitoreo | WebSocket | `POST /api/v2/order` (polling) |
| Fees | 0.1%-0.5% | 0.5% float / 1% fixed |
| Affiliate | — | `afftax` + `refcode` ⭐ |
| Lightning | Invoice-based | BTCLN currency code |

## API Endpoints a Usar

### 1. Rates (público, sin auth)
```
GET https://ff.io/rates/float.xml
→ XML con todos los pares, rates, fees, limites
→ Cache 30s
```

### 2. Get Price (needs API key)
```
POST /api/v2/price
Body: { fromCcy:"USDTTRC", toCcy:"BTC", amount:100, direction:"from", type:"float" }
Headers: X-API-KEY, X-API-SIGN (HMAC-SHA256)
→ Rate, monto a recibir, limites, errores
```

### 3. Create Order
```
POST /api/v2/create
Body: { fromCcy, toCcy, amount, direction, type, toAddress }
→ Order ID, token, deposit address, expiry
```

### 4. Get Order Status (polling)
```
POST /api/v2/order
Body: { id: "ABC123", token: "xxx" }
→ Status: NEW, DEPOSIT, EXCHANGE, DONE, EXPIRED
```

## Arquitectura Dual-Backend

```
Usuario quiere swap USDT → BTC
    │
    ▼
Bot detecta: es USDT/USDC → usa FixedFloat
    │
    ├── GET /rates/float.xml → verificar par disponible
    ├── POST /api/v2/price → calcular monto a recibir
    ├── Mostrar fee breakdown (SwapBot + FF)
    ├── POST /api/v2/create → crear orden en FF
    ├── Mostrar dirección de depósito FF al usuario
    ├── Polling /api/v2/order cada 30s
    └── DONE → guardar en DB + trackear
```

```
Usuario quiere swap BTC → USDT
    │
    ▼
Bot detecta: usa Boltz (si es BTC on-chain ↔ Lightning) o FixedFloat (si es cross-currency)
    │
    ├── Boltz: para BTC↔LN no-custodial (preferido)
    └── FixedFloat: para BTC→USDT o USDT→BTC (custodial)
```

## Flujo de Swap USDT/USDC con FixedFloat

### Send Flow (USDT → BTC):
```
1. User selecciona: USDT → BTC
2. User selecciona red: TRC-20, ERC-20, BEP-20, Arbitrum
3. User ingresa monto
4. Bot → GET /rates/float.xml (cacheado)
5. Bot → POST /api/v2/price (con HMAC)
6. Bot muestra: "Recibiras X BTC, fee FixedFloat: Y, comision SwapBot: Z"
7. User confirma
8. Bot → POST /api/v2/create (toAddress = admin wallet BTC/LN)
9. Bot muestra: "Envia X USDT a esta direccion (TRC-20): T..."
10. Polling /api/v2/order hasta DONE
11. Completado → treasury + raffle + guardar DB
```

### Receive Flow (BTC → USDT):
```
1. User selecciona: BTC → USDT
2. User selecciona red destino: TRC-20, ERC-20, BEP-20
3. User ingresa direccion USDT destino
4. User ingresa monto BTC
5. Bot → POST /api/v2/create (toAddress = user's USDT address)
6. Bot muestra: "Envia X BTC a bc1q..."
7. Polling hasta DONE
```

## FixedFloat Auth (HMAC-SHA256)

```typescript
import crypto from 'crypto';

function sign(data: object, secret: string): string {
  const json = JSON.stringify(data);
  return crypto.createHmac('sha256', secret).update(json).digest('hex');
}

// Headers
headers = {
  'X-API-KEY': apiKey,
  'X-API-SIGN': sign(requestBody, apiSecret),
  'Content-Type': 'application/json; charset=UTF-8',
}
```

## Nota IMPORTANTE (Custodia)

FixedFloat es **custodial**. El bot NUNCA debe crear órdenes con la wallet del admin como `toAddress` sin que el admin lo configure explícitamente. Las comisiones se trackean en DB pero el payout se hace manual o vía /admin withdraw.

**Alternativa para no-custodial**: Usar FixedFloat solo como rate oracle para el usuario, y que ellos hagan el swap manualmente. El bot solo muestra la calculadora.

## Implementación

### Phase 8A: FixedFloat Client (2d)
- T-045: HTTP client con HMAC-SHA256 signing
- T-046: Rate fetcher from XML (público, sin auth)
- T-047: Price + Create endpoints con HMAC auth
- T-048: Order status polling

### Phase 8B: Swap Flow Integration (2d)
- T-049: Activar USDT/USDC en menú de swap (quitar "Proximamente")
- T-050: Network selection → FixedFloat rate lookup
- T-051: Crear orden en FixedFloat + mostrar deposit address
- T-052: Polling status + completar swap

### Phase 8C: Dual Backend Router (1d)
- T-053: Auto-seleccionar backend (Boltz para BTC, FF para USDT)
- T-054: Fallback entre backends
- T-055: Config vars: FF_API_KEY, FF_API_SECRET
