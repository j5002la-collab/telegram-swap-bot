# Telegram Swap Bot

🤖 Bot de Telegram para intercambios instantáneos USDT/USDC ↔ BTC/Lightning.

No-custodial. Sin registro. Sin KYC. Sin ordenes P2P. Solo pega una factura, confirma y listo.

## Características

- 🔄 **Swap directo**: USDT ↔ BTC, USDC ↔ BTC, Lightning ↔ On-chain
- ⚡ **No-custodial**: El bot nunca retiene tus fondos — los swaps son atómicos vía Boltz
- 💰 **Comisión transparente**: 2.5% del monto, detallado antes de confirmar
- 🎁 **Sorteo semanal**: 0.1% del volumen semanal se sortea entre los usuarios
- 🤖 **Panel admin**: Estadísticas en tiempo real, cambios de comisión, broadcast
- 🛡️ **Manejo de errores**: Instrucciones de reembolso automáticas si algo falla

## Stack

| Capa | Tecnología |
|---|---|
| Bot Framework | [Telegraf](https://github.com/telegraf/telegraf) (Node.js + TypeScript) |
| Swap Engine | [Boltz API v2](https://api.docs.boltz.exchange/) (REST + WebSocket) |
| Base de datos | MongoDB (Mongoose) |
| Agendador | node-schedule |
| Logging | Winston |

## Cómo Funciona

```
1. El usuario envía /swap al bot
2. Selecciona dirección (USDT→BTC, BTC→USDT, etc.)
3. Ingresa el monto
4. El bot muestra desglose de comisiones
5. Usuario confirma
6. El bot orquesta el swap vía Boltz API
7. Notificación de completado
```

## 🚀 Deploy

Ver la guía completa: [DEPLOY.md](DEPLOY.md)

Despliegue rápido con Docker:
```bash
git clone https://github.com/j5002la-collab/telegram-swap-bot.git
cd telegram-swap-bot
cp .env-sample .env
# Editar .env con tu BOT_TOKEN y ADMIN_IDS
docker compose up -d
```

Guía para Umbrel: [DEPLOY_UMBREL.md](DEPLOY_UMBREL.md)

## Desarrollo

### Prerrequisitos

- Node.js 18+
- MongoDB
- Cuenta en [Boltz](https://boltz.exchange/) (acceso a API pública)

### Instalación

```bash
git clone https://github.com/j5002la-collab/telegram-swap-bot.git
cd telegram-swap-bot
npm install
cp .env-sample .env
# Editar .env con tu configuración
npm run dev
```

### Variables de Entorno

| Variable | Descripción |
|---|---|
| `BOT_TOKEN` | Token del bot de Telegram |
| `MONGO_URI` | URI de conexión a MongoDB |
| `BOLTZ_API_URL` | URL de la API de Boltz |
| `COMMISSION_RATE` | Tasa de comisión (default: 2.5) |
| `ADMIN_IDS` | IDs de Telegram de administradores |

## Especificaciones

Este proyecto usa [Spec Kit](https://github.github.com/spec-kit/) para desarrollo guiado por especificaciones. Los documentos están en `.specify/`:

- [Constitución](.specify/memory/constitution.md) — Principios del proyecto
- [Especificación](.specify/specs/001-swap-bot-core.md) — Especificación funcional
- [Plan](.specify/plans/001-swap-bot-plan.md) — Plan de implementación
- [Tareas](.specify/tasks/001-swap-bot-tasks.md) — Tareas granulares

## Licencia

MIT
