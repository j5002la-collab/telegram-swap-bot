---
id: "006"
title: "Swap Status Tracking & Notifications"
status: "draft"
version: "1.0.0"
created: "2026-05-14"
---

# Swap Status Tracking — Especificación

## Problema

El bot crea swaps exitosamente (Boltz + ChangeNOW) pero no informa al usuario sobre:
- Si se recibió el depósito
- En qué estado está el swap
- Cuándo se completa
- Transacción on-chain (tx hash)

## Solución

### ChangeNOW: Polling cada 15s

```
GET /v2/exchange/by-id?id=618210feb7c0e7
→ { id, status: "waiting"|"confirming"|"exchanging"|"sending"|"finished"|"failed"|"refunded",
    payinHash, payoutHash }
```

Estados y mensajes:
- `waiting` → "Esperando tu depósito de X USDC..."
- `confirming` → "Depósito detectado, esperando confirmaciones..."
- `exchanging` → "Intercambiando USDC → BTC..."
- `sending` → "Enviando BTC a tu dirección..."
- `finished` → "✅ Intercambio completado! Tx: <hash>"
- `failed` → "❌ Error. Contacta a soporte."
- `refunded` → "↩️ Reembolsado."

### Boltz: Ya tenemos WebSocket, mejorar mensajes

Estados actuales → agregar más contexto:
- `invoice.set` → "Esperando transacción on-chain de X sats a bc1q..."
- `transaction.mempool` → mostrar tx hash
- `transaction.confirmed` → mostrar confirmaciones
- `transaction.claimed` → "✅ Completado! Tx: <hash>"

### Persistencia

Actualizar Swap.status en DB:
- `pending` → `completed` → `failed`

## Tareas

- [ ] T-001: Polling loop para ChangeNOW (setInterval 15s, timeout 30min)
- [ ] T-002: Mapeo CNStatus → mensajes usuario
- [ ] T-003: Editar mensaje Telegram en cada actualización (no enviar nuevo)
- [ ] T-004: Mejorar mensajes Boltz WebSocket
- [ ] T-005: Guardar tx hash en Swap al completar
