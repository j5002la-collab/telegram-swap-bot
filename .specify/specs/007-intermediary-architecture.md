---
id: "007"
title: "Intermediary Architecture — Commission Collection"
status: "draft"
version: "1.0.0"
created: "2026-05-14"
---

# Intermediary Architecture — Cobro de Comisión

## Problema

Actualmente pasamos la invoice del usuario directamente a Boltz. Boltz calcula `expectedAmount` basado en SUS fees (0.1% + minería), sin saber de nuestra comisión (2.5%). El usuario podría mandar solo el `expectedAmount` de Boltz y nosotros no cobraríamos nada.

## Solución Propuesta: Intermediación con Wallet Propia

### Flujo Submarine (BTC on-chain → LN del usuario)

```
┌──────────┐     BTC on-chain      ┌──────────────┐     BTC on-chain     ┌─────────┐
│  Usuario │ ───────────────────→  │  SwapBot     │ ──────────────────→  │  Boltz  │
│          │    envía X sats       │  (WALLET)    │   envía neto−fee    │         │
└──────────┘                       └──────────────┘                      └─────────┘
                                         │                                     │
                                         │ comisión 2.5%                       │ paga invoice
                                         │ raffle 0.1%                         │ LN al user
                                         ↓                                     ↓
                                    Treasury                              Lightning
```

### Paso a paso

1. **Usuario pega invoice LN (ej: 45,000 sats)**
2. **Bot calcula:**
   - Boltz fee: 0.1% + 302 sats minería
   - SwapBot comisión: 2.5%
   - Raffle pool: 0.1%  
   - Total source = (invoice + minerFee) / (1 − (commission% + boltzFee% + raffle%) / 100)
   - ≈ (45,000 + 302) / (1 − (2.5 + 0.1 + 0.1) / 100)
   - ≈ 45,302 / 0.973
   - ≈ 46,541 sats
3. **Bot muestra:** "Envía 46,541 sats a bc1q... (nuestra wallet)"
4. **Usuario envía BTC a nuestra wallet**
5. **Bot monitorea la wallet** — detecta depósito
6. **Bot deduce comisiones** (1,164 + 47 = 1,211 sats) → treasury + raffle
7. **Bot crea Boltz submarine swap** con la invoice original
   - Boltz devuelve `expectedAmount` (~45,347 sats) y `address`
8. **Bot envía `expectedAmount` desde nuestra wallet a la address de Boltz**
9. **Boltz paga la invoice LN al usuario**
10. **Bot actualiza status** → completado

### Ventajas

- ✅ Comisión garantizada — el usuario envía a NUESTRA wallet
- ✅ Transparente — el usuario ve exactamente cuánto enviar
- ✅ Tracking completo — depósito → swap → completado
- ✅ No requiere Lightning propio

### Requisitos nuevos

- ✅ `WALLET_BTC_ADDRESS` — ya configurada en `.env`
- ❌ **Necesitamos**: private key para firmar transacciones desde nuestra wallet
- ❌ **Necesitamos**: UTXO management (seleccionar inputs, construir tx)
- ❌ **Necesitamos**: monitoreo de depósitos (mempool.space API o electrum)
- ❌ **Necesitamos**: `bitcoinjs-lib` para construir y firmar transacciones

## Alternativa: Invoice Intermediaria

Si NO queremos manejar wallet propia:

1. Generamos una invoice LN NUESTRA (necesitamos Lightning node)
2. Usuario paga NUESTRA invoice → recibimos en Lightning
3. Deducimos comisión del monto recibido
4. Pagamos la invoice original del usuario con el neto

Requiere: Lightning node (LND, c-lightning, o Alby/Breez)

## Implementación (Fase 1: Wallet Propia)

### T-001: Configurar wallet
- `WALLET_BTC_ADDRESS` (ya existe)
- `WALLET_BTC_PRIVATE_KEY` (WIF format, nueva variable)

### T-002: Monitoreo de depósitos
- Polling a mempool.space API cada 30s
- Detectar transacciones a nuestra address
- Verificar confirmaciones

### T-003: Construir y firmar transacciones
- `bitcoinjs-lib` + `ecpair` (ya instalado)
- Seleccionar UTXOs
- Construir PSBT
- Firmar con nuestra private key
- Broadcast via mempool.space API

### T-004: Flujo de swap con wallet propia
- Mostrar nuestra address al usuario
- Monitorear depósito
- Al confirmar: deducir comisiones, crear swap Boltz
- Enviar BTC a address de Boltz
- Monitorear WebSocket Boltz

## Riesgos

- ⚠️ Private key en .env → seguridad
- ⚠️ Doble gasto si dos swaps simultáneos
- ⚠️ Fee estimation para la tx de salida
- ⚠️ Timeout de invoice LN mientras esperamos confirmaciones
