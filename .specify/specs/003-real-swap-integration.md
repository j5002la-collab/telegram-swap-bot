---
id: "003"
title: "Real Swap Integration via Boltz API v2"
status: "implemented"
version: "3.1.0"
updated: "2026-05-14"
based_on: "https://api.docs.boltz.exchange/api-v2.html"
---

# Boltz API v2 — Integración Corregida

## Lecciones Aprendidas (2026-05-14)

### ❌ Error #1: `refundPublicKey` / `claimPublicKey` incorrectos
- **Causa**: Usábamos `crypto.randomBytes(32).toString('hex')` → 64 chars hex
- **Error Boltz**: `"all elements of pubkeys must have same length"`
- **Fix**: Usar `ECPairFactory(ecc).makeRandom()` de `ecpair` + `tiny-secp256k1`
  - `Buffer.from(keys.publicKey).toString('hex')` → 66 chars (33-byte compressed pubkey)
- **Deps**: `npm install ecpair tiny-secp256k1`

### ❌ Error #2: `next()` en handlers de texto
- **Causa**: `handleSwapInvoice` hacía `return` sin `next()`, rompiendo la cadena Telegraf
- **Fix**: `return next()` en todos los handlers de texto cuando no procesan

### ✅ Correcto
- Preimage y preimageHash de reverse swaps — se generan bien con `crypto.randomBytes(32)` + `sha256`
- WebSocket subscription — funciona
- Rate fetching (GET /swap/submarine, GET /swap/reverse) — funciona

## Submarine Swap (BTC On-chain → Lightning)

```
POST /v2/swap/submarine
{
  from: "BTC",
  to: "BTC",
  invoice: "lnbc...",                          // Lightning invoice del usuario
  refundPublicKey: "<33-byte secp256k1 hex>"   // ECPair.makeRandom().publicKey
}
Response: { id, address, expectedAmount, claimPublicKey, timeoutBlockHeight, swapTree }
```

## Reverse Swap (Lightning → BTC On-chain)

```
POST /v2/swap/reverse
{
  from: "BTC",
  to: "BTC",
  invoiceAmount: 100000,                                  // sats a recibir
  claimPublicKey: "<33-byte secp256k1 hex>",              // ECPair.makeRandom().publicKey
  preimageHash: "<sha256 hex>"                            // sha256(randomBytes(32))
}
Response: { id, invoice, lockupAddress, expectedAmount, timeoutBlockHeight, refundPublicKey }
```

## Estados WebSocket

| Estado | Significado | Acción |
|---|---|---|
| `swap.created` | Swap creado | Mostrar address/invoice al usuario |
| `invoice.set` | Invoice validada | — |
| `transaction.mempool` | Tx en mempool | "Tx detectada en la red" |
| `transaction.confirmed` | 1 confirmación | "Confirmada. Procesando..." |
| `invoice.pending` | Pagando invoice | — |
| `transaction.claim.pending` | Listo para claim | — |
| `transaction.claimed` | ✅ Completado | Guardar en DB, tracking |
| `invoice.settled` | ✅ Completado | Guardar en DB, tracking |
| `invoice.failedToPay` | ❌ Fallo | "Error en pago. Fondos reembolsados." |
| `swap.expired` | ❌ Timeout | "Expirado. Fondos reembolsados." |

## NO implementado (v1)
- Firma cooperativa MuSig2 — NO necesario, Boltz hace script-path claim
- Validación de swapTree — NO para v1
- Claim transaction manual — NO, el usuario solo envía/recibe
