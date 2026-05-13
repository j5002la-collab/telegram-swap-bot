---
id: "005"
title: "ChangeNOW Integration — USDT/USDC Multi-Network Swaps"
status: "draft"
version: "5.0.0"
created: "2026-05-13"
based_on: "https://changenow.io/api"
---

# ChangeNOW — USDT/USDC ↔ BTC/Lightning

## Descubrimiento
ChangeNOW tiene API viva, 1500+ assets, afiliado con comision configurable (desde 0.4%), y es usado por Exodus, Trezor, CakeWallet, Bitcoin.com.

## API Endpoints (v2)

### 1. List currencies (public)
```
GET /v2/exchange/currencies?flow=fixed-rate
Headers: x-api-key: YOUR_KEY
→ { currencies: [{ticker:"btc",name:"Bitcoin",network:"BTC",...}, ...] }
```

### 2. Min amount
```
GET /v2/exchange/min-amount?fromCurrency=usdttrc&toCurrency=btc&flow=fixed-rate
Headers: x-api-key: YOUR_KEY
→ { minAmount: "10.50" }
```

### 3. Estimate exchange
```
GET /v2/exchange/estimated-amount?fromCurrency=usdttrc&toCurrency=btc&fromAmount=100&flow=fixed-rate
Headers: x-api-key: YOUR_KEY
→ { estimatedAmount: "0.00125", rateId: "abc", validUntil: "..." }
```

### 4. Create transaction
```
POST /v2/exchange
Headers: x-api-key: YOUR_KEY, Content-Type: application/json
Body: {
  fromCurrency: "usdttrc",
  toCurrency: "btc",
  fromAmount: "100",
  toAmount: "0.00125",
  address: "bc1q...user...wallet",
  flow: "fixed-rate",
  rateId: "abc"
}
→ { id: "abc123", payinAddress: "T...", payoutAddress: "bc1q...", amount: {...}, status: "waiting" }
```

### 5. Check status
```
GET /v2/exchange/by-id?id=abc123
Headers: x-api-key: YOUR_KEY
→ { status: "waiting"|"confirming"|"exchanging"|"sending"|"finished"|"failed"|"refunded" }
```

## Currencies que nos interesan

| ChangeNOW ticker | Red | Nombre |
|---|---|---|
| `btc` | BTC | Bitcoin |
| `btcln` | Lightning | Bitcoin Lightning |
| `usdttrc` | TRC-20 | Tether USD (Tron) |
| `usdterc20` | ERC-20 | Tether USD (Ethereum) |
| `usdtbsc` | BEP-20 | Tether USD (BSC) |
| `usdtarbitrum` | Arbitrum | Tether USD (Arbitrum) |
| `usdcerc20` | ERC-20 | USD Coin (Ethereum) |
| `usdcpolygon` | Polygon | USD Coin (Polygon) |
| `usdcarbitrum` | Arbitrum | USD Coin (Arbitrum) |
| `usdcbase` | Base | USD Coin (Base) |

## Flujo de Swap USDT → BTC con ChangeNOW

```
1. User: "USDT (TRC-20) → BTC"
2. User ingresa monto: 100 USDT
3. Bot → GET /estimated-amount?from=usdttrc&to=btc&amount=100
4. Bot calcula comision (2.5%) y muestra:
   "Recibiras ~0.00120 BTC | Fee SwapBot: 2.50 USDT | Fee red: ~0.50 USDT"
5. User confirma
6. Bot → POST /v2/exchange (toAddress = wallet del usuario)
7. Bot muestra: "Envia 100 USDT a: T..."
8. Polling GET /by-id cada 15s
9. status=finished → guardar DB + treasury + raffle
```

## Para el admin (TÚ)

1. Registrarse en https://changenow.io/affiliate
2. Obtener API Key del dashboard
3. Configurar wallet de retiro de ganancias
4. La comision del afiliado se acumula en tu cuenta ChangeNOW
5. Retiras cuando quieras a BTC, USDT, etc.

## Variables .env nuevas

```env
CHANGENOW_API_KEY=tu_api_key_aqui
CHANGENOW_AFFILIATE_ID=tu_affiliate_id
```

## Arquitectura Dual

```
Swap Request
    │
    ├── BTC ↔ Lightning → Boltz API (non-custodial)
    └── USDT/USDC ↔ BTC → ChangeNOW API (custodial exchange)
```

## Implementación

### Phase 5A: ChangeNOW Client (1d)
- T-056: HTTP client con x-api-key header
- T-057: getCurrencies(), getMinAmount(), estimate(), createExchange(), getStatus()
- T-058: Rate fetcher and cache

### Phase 5B: Swap Flow (2d)
- T-059: Activar USDT/USDC en menú (/swap)
- T-060: Network selection → mapear a tickers ChangeNOW
- T-061: Estimar + fee breakdown + confirmar
- T-062: Crear exchange + mostrar deposit address
- T-063: Polling status + completar
- T-064: Guardar DB, treasury, raffle

### Phase 5C: Polish (1d)
- T-065: Dual backend router (Boltz vs ChangeNOW)
- T-066: Auto-seleccionar según par
- T-067: Deploy y testing en prod
