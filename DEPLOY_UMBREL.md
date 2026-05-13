# 🏠 Deploy en Umbrel — Guía Rápida

## ¿Qué es Umbrel?

[Umbrel](https://umbrel.com) es un servidor personal que corre en una Raspberry Pi,
mini PC, o máquina virtual. Corre Linux y tiene Docker preinstalado.

## Paso a Paso

### 1. Conectarte a tu Umbrel

```bash
ssh umbrel@umbrel.local
```

Si no funciona con `.local`:
```bash
ssh umbrel@192.168.1.X   # Busca la IP de tu Umbrel en el router
```

Contraseña: la que configuraste al instalar Umbrel.

### 2. Clonar el Bot

```bash
cd ~
git clone https://github.com/j5002la-collab/telegram-swap-bot.git
cd telegram-swap-bot
```

### 3. Configurar .env

```bash
nano .env
```

Pega esto y edita con tus valores:

```env
BOT_TOKEN=123456:ABC-DEF1234ghij
MONGO_URI=mongodb://mongo:27017/telegram-swap-bot
BOLTZ_API_URL=https://api.boltz.exchange
COMMISSION_RATE=2.5
ADMIN_IDS=123456789
LOG_LEVEL=info
TZ=UTC
```

**¿Cómo obtengo el BOT_TOKEN?**
→ Habla con [@BotFather](https://t.me/botfather) en Telegram, `/newbot`

**¿Cómo obtengo mi ADMIN_ID?**
→ Habla con [@userinfobot](https://t.me/userinfobot) en Telegram, `/start`

### 4. Levantar con Docker

```bash
docker compose up -d
```

### 5. Verificar

```bash
# Ver que los contenedores están corriendo
docker compose ps

# Ver los logs
docker compose logs -f swapbot
```

Deberías ver algo como:
```
[16:35:00] info: Connected to MongoDB at mongodb://mongo:27017/telegram-swap-bot
[16:35:00] info: Bot launched successfully
[16:35:00] info: Raffle scheduler started (Sundays 23:59 UTC)
[16:35:00] info: Telegram Swap Bot is running
```

### 6. Probar en Telegram

Abre `https://t.me/tu_swapbot_bot` y envía `/start`.

## Configuración de Comandos en BotFather

```
/setcommands
@tu_swapbot_bot

swap - Iniciar un intercambio USDT/BTC
rates - Ver tasas en vivo
raffle - Información del sorteo
help - Ayuda
```

## Mantenimiento

```bash
# Verificar estado
docker compose ps

# Ver logs
docker compose logs -f

# Reiniciar después de actualizar
git pull
docker compose down
docker compose up -d --build

# Backup de MongoDB
docker exec swapbot-mongo mongodump --archive > backup_$(date +%Y%m%d).archive
```

## Recursos en Umbrel

El bot usa ~150MB RAM y casi nada de CPU. Cero impacto en otras apps de Umbrel
(Bitcoin Node, Lightning Node, etc.).

## Solución de Problemas

**"Bot no responde"**
→ Revisa que `BOT_TOKEN` sea correcto en `.env`
→ `docker compose logs swapbot`

**"MongoDB connection error"**
→ Revisa que el puerto 27017 no esté en uso
→ `sudo lsof -i :27017`
→ Si lo está, cambia el puerto en `docker-compose.yml`

**"WebSocket connection failed"**
→ Verifica que Umbrel tenga acceso a internet
→ `curl https://api.boltz.exchange/v2/swap/submarine`

**Quiero backup de la base de datos**
→ `docker exec swapbot-mongo mongodump --archive > backup.archive`
→ Copia el archivo a un lugar seguro
