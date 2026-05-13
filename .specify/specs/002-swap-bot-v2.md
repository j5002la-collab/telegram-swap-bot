---
id: "002"
title: "Swap Bot v2 — Multi-Currency + Boltz Pro"
status: "draft"
version: "2.0.0"
created: "2026-05-13"
updated: "2026-05-13"
---

# Telegram Swap Bot v2

## 1. USDT/USDC Support (Multi-Network)

### Network Selection
Cuando el user selecciona USDT o USDC, debe elegir la red:
- TRC-20 (Tron) — fees bajos, mas popular
- ERC-20 (Ethereum) — fees altos
- BEP-20 (BSC) — fees medios
- Arbitrum (USDT0)

### Flujo
```
/swap
  → Seleccionar moneda: BTC | USDT | USDC
    → Seleccionar red (si es USDT/USDC)
      → Seleccionar direccion: A BTC | A Lightning
        → Ingresar monto
          → Confirmar
```

### Implementacion
- Dynamic pair discovery: consultar Boltz API para ver que pares estan live
- Si USDT/USDC no disponible → mostrar "Proximamente" en gris
- Cuando disponibles → mostrar con fees y red correspondiente

## 2. Calculadora (/calc) — NUEVO

### Reemplaza /rates
- `/rates` ELIMINADO — exponia las tasas bajas de Boltz
- `/calc` NUEVO — calculadora de conversion

### Que Muestra
```
Calculadora SwapBot

Si envias: 100,000 sats (0.001 BTC)

Recibiras: ~96,500 sats

Desglose:
  SwapBot (2.5%): 2,500 sats
  Red (~0.5%): ~1,000 sats

Al sorteo (0.1%): 100 sats

Premio sorteo: 50,000 sats (12 participantes)
```

### Boton en Menu Principal
`Calculadora` → abre /calc

## 3. Boltz Pro — INTERNO (Admin Only)

### Que es
- Proporcionar liquidez a Boltz para ganar yield extra
- Aumenta el margen del bot sin afectar al usuario
- Totalmente invisible para el usuario final

### Admin Commands
```
/admin pro status   → Yield, APY, deployed amount
/admin pro deposit  → Deploy treasury a Pro
/admin pro withdraw → Retirar de Pro
```

## 4. Menu Principal (Actualizado)

```
SwapBot — Cambios instantaneos BTC/Lightning

[ Iniciar Swap ]           ← /swap
[ Calculadora ] [ Sorteo ] ← /calc + /raffle
[ Ayuda ]                  ← /help
```

## 5. Comandos Disponibles

```
/start  — Menu principal
/swap   — Iniciar intercambio (BTC on-chain ↔ Lightning)
/calc   — Calculadora: cuanto recibes con fees
/raffle — Sorteo semanal (premio, participantes)
/help   — Ayuda
/admin  — Panel admin (solo admins)
```

## 6. Fases

### Phase 6A: Research USDT (1 dia)
- Probar Boltz API con from=USDT
- Verificar que redes soporta (TRC-20, ERC-20, etc.)
- Documentar hallazgos

### Phase 6B: Calculadora + Eliminar /rates (1 dia)
- `/calc` con fee breakdown + raffle info
- Eliminar `/rates` y todo su codigo
- Actualizar menu principal

### Phase 6C: Multi-Currency + Chain Selection (2-3 dias)
- Network selection en swap flow
- Dynamic pair detection
- Fallback cuando pares no disponibles

### Phase 6D: Boltz Pro (2 dias)
- Investigar API de Boltz Pro
- Modulo interno admin-only
- Yield tracking

### Phase 6E: Polish (1 dia)
- WebSocket live status
- /myswaps command
- Tests
