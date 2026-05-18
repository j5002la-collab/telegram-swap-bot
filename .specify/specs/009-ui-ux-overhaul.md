# SPEC: UI & UX Overhaul — Telegram Swap Bot

**Status**: draft | **Version**: 1.0.0 | **Created**: 2026-05-18

---

## Problemas Detectados

### 1. Notificaciones inconsistentes
- El mensaje "Usa /swap para un nuevo intercambio" aparece ANTES de que termine el flujo (línea 1263 en swap.ts: `clearSs(ctx); await ctx.reply('Usa /swap...')`)
- No hay notificación final cuando el swap se completa realmente
- Cuando el swap falla, a veces no se notifica al usuario
- Admin no recibe alertas en varios casos de error

### 2. Menú principal desordenado
- El `/start` muestra inline keyboard con 4 botones pero no tiene botón de `/admin`
- Las tasas se muestran en un formato poco claro
- No hay acceso rápido a swap desde todos los menús

### 3. Calculadora de comisiones (`/calc`)
- Solo acepta números enteros (no maneja decimales para montos pequeños)
- Siempre usa `submarine` (BTC→LN), no muestra reverse (LN→BTC)
- No persiste ni guarda histórico

### 4. Admin Panel limitado
- No puede ver swaps pendientes atascados
- No puede cambiar estado de swaps manualmente
- No puede eliminar swaps viejos
- Swaps en `waiting_deposit` nunca se limpian automáticamente

### 5. Flujo de mensajes inconsistente
- El mensaje "Usa /swap para un nuevo intercambio" se muestra al confirmar, no al terminar
- Reverse swap: invoice aparece y desaparece por WS status updates
- No hay confirmación visual clara cuando un swap termina

---

## SPEC: Mejoras (ordenadas por prioridad)

### 🔴 S-001: Notificación de finalización real

**Problema**: `clearSs(ctx); await ctx.reply('Usa /swap...')` se ejecuta al confirmar, no al terminar.

**Fix**:
- Remover `ctx.reply('Usa /swap...')` del bloque de confirmación
- Agregarlo en `updateSwapMessage()` cuando `status === 'transaction.claimed' || status === 'invoice.settled'`
- Agregar mensaje final al usuario con resumen: monto enviado, recibido, TX ID

### 🔴 S-002: Reverse swap — no pisar invoice

**Ya arreglado** en `381c293`. Verificar que funcione en prod.

### 🟡 S-003: Menú principal mejorado

```
/start →
  🔄 Iniciar Swap (→ /swap)
  🧮 Calculadora (→ /calc)
  📊 Tasas en vivo
  🎁 Sorteo
  ❓ Ayuda

+  👤 Mi perfil (swaps hechos, volumen)
+  📋 Mis últimos swaps
```

Agregar botón persistente "🔙 Menú" en todos los sub-flujos.

### 🟡 S-004: Calculadora mejorada

**Cambios**:
- Mostrar ambos tipos de swap (BTC→LN y LN→BTC)
- Aceptar decimales (convertir a sats automáticamente)
- Mostrar tasa en vivo como "1 BTC = X sats (Lightning)"
- Agregar botón "🔄 Hacer este swap" que redirige a /swap con monto pre-llenado

### 🟡 S-005: Admin — gestión de swaps pendientes

**Nuevo comando**: `/admin pending`
- Lista swaps con `status: 'pending'` ordenados por antigüedad
- Cada swap muestra: swapId, dirección, monto, antigüedad, estado Boltz
- Botones inline por swap:
  - ❌ Marcar como failed
  - ✅ Forzar completed
  - 🗑 Eliminar

**Nuevo comando**: `/admin cancel SWAP-ID`
- Marca swap como failed + refunded
- Si tiene depósito confirmado, intenta auto-refund

### 🟡 S-006: Auto-limpieza de swaps viejos

**Job diario** (corre al iniciar + cada 24h):
- Swaps `ONCHAIN2LN` + `status: 'pending'` + `boltzStatus: 'waiting_deposit'` + `createdAt > 5 días` → marcar `failed` + notificar admin
- Swaps `LN2ONCHAIN` + `status: 'pending'` + `createdAt > 7 días` → marcar `failed` + notificar admin

### 🟢 S-007: Confirmación visual del swap

**Al terminar (exitosa)**:
```
🎉 ¡Swap completado!
━━━━━━━━━━━━━━━━━━
Enviaste:   50,000 sats (BTC)
Recibiste:  48,750 sats (Lightning)
Swap ID:    SWAP-XXXXXXXXXXXX
Boltz ID:   u5Woy5cXbIhv
━━━━━━━━━━━━━━━━━━
Usa /swap para un nuevo intercambio.
```

**Al terminar (fallo)**:
```
❌ Swap no completado
━━━━━━━━━━━━━━━━━━
Swap ID:    SWAP-XXXXXXXXXXXX
Estado:     invoice.failedToPay
Acción:     Tus fondos serán reembolsados
━━━━━━━━━━━━━━━━━━
Contacta a soporte con este ID.
```

### 🟢 S-008: Notificaciones admin mejoradas

**Actualmente roto**: `notifyAdmins` usa Markdown legacy que se rompe con `_` en strings.

**Fix**: Migrar `notifyAdmins` a usar `parse_mode: 'HTML'` y `<b>/<code>/<pre>` tags.
O mantener Markdown pero con escape automático de `_ * [ ] ( ) ~ ` > # + - = | { } . !`

---

## Plan de implementación

| Spec | Tiempo estimado | Archivos |
|------|----------------|----------|
| S-001 | 30 min | `swap.ts` |
| S-003 | 30 min | `messages.ts`, `start.ts`, `showHelp.ts` |
| S-005 | 45 min | `admin.ts`, `swap.ts` |
| S-006 | 20 min | `jobs/cleanup.ts`, `index.ts` |
| S-008 | 15 min | `swap.ts` (notifyAdmins) |
| S-004 | 30 min | `calc.ts` |
| S-007 | 15 min | `swap.ts` (updateSwapMessage) |
| **Total** | **~3 horas** | |

---

## Resumen visual del flujo nuevo

```
/start
├─ 🔄 Iniciar Swap → /swap (flujo actual mejorado)
│   ├─ Seleccionar moneda
│   ├─ Dirección
│   ├─ Invoice / Monto
│   ├─ Resumen → Confirmar
│   └─ ⏳ Procesando... → 🎉 Completado / ❌ Falló
│       └─ "Usa /swap para nuevo intercambio" (SOLO al terminar)
│
├─ 🧮 Calculadora
│   ├─ Ingresar monto
│   ├─ Ver ambos swaps (BTC→LN y LN→BTC)
│   └─ "Hacer este swap" → /swap con monto
│
├─ 📊 Tasas en vivo
├─ 🎁 Sorteo
└─ ❓ Ayuda

/admin
├─ volume / swaps / users / fee / raffle / treasury / withdraw / broadcast / pro
├─ 🆕 pending → Lista swaps atascados con acciones
└─ 🆕 cancel SWAP-ID → Forzar cancelación + refund
```

---

## Command Reference (nuevo)

| Comando | Acceso | Qué hace |
|---------|--------|----------|
| `/start` | Todos | Menú principal |
| `/swap` | Todos | Iniciar intercambio |
| `/calc` | Todos | Calculadora |
| `/cancel` | Todos | Cancelar swap en curso |
| `/help` | Todos | Ayuda |
| `/admin` | Admin | Panel admin |
| `/admin pending` | Admin | Swaps pendientes |
| `/admin cancel <id>` | Admin | Cancelar swap |
| `/admin cleanup` | Admin | Limpiar swaps viejos |
