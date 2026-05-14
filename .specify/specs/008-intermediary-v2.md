---
id: "008"
title: "Intermediary Mode v2 — Deposit to Our Wallet, Forward to Boltz"
status: "draft"
version: "1.0.0"
created: "2026-05-14"
---

# Intermediary Mode v2

## Objetivo

El bot SIEMPRE muestra la dirección del operador (`WALLET_BTC_ADDRESS`).
El usuario deposita ahí. El bot detecta el depósito, deduce comisión, crea swap
con Boltz y envía los BTC a la dirección de Boltz.

## Flujo

```
Usuario pega invoice → fee breakdown → Confirmar
  → Bot: "Envía X sats a WALLET_BTC_ADDRESS" (mensaje persistente)
  → Bot monitorea depósitos en background (polling mempool.space cada 20s)
  → Depósito confirmado:
      → Deduce comisión 2.5% + raffle 0.1%
      → POST /swap/submarine a Boltz (con invoice del usuario)
      → Construye TX bitcoin → envía expectedAmount a address de Boltz
      → Broadcast TX via mempool.space
      → Suscribe WebSocket Boltz
      → Actualiza mensaje: "Depósito recibido → Swap creado → Esperando..."
  → Boltz completa → mensaje: "✅ Completado"
```

## Implementación por fases

### Fase 1: Mostrar nuestra address (hoy, 5 min)
- En handleSwapConfirm, reemplazar address de Boltz por `WALLET_BTC_ADDRESS`
- Mostrar monto correcto (sourceAmount calculado con comisiones)
- Mensaje persistente (ctx.reply)

### Fase 2: Monitoreo de depósito (background)
- Polling cada 20s a mempool.space API
- Detectar TX con amount >= sourceAmount a nuestra address
- Actualizar mensaje con progreso

### Fase 3: Crear swap Boltz + enviar BTC (on deposit)
- Al confirmar depósito:
  - POST /swap/submarine con invoice del usuario
  - sendToAddress(Boltz.address, Boltz.expectedAmount)
  - Suscribir WS

### Fase 4: WS status tracking
- updateSwapMessage en el mensaje persistente
- Address nuestra siempre visible, status se actualiza

## Riesgos

- ⚠️ La wallet debe tener fondos (UTXOs) para pagar el fee de la TX de salida
- ⚠️ Timeout de invoice LN mientras esperamos confirmaciones
- ⚠️ Doble gasto si dos depósitos simultáneos
