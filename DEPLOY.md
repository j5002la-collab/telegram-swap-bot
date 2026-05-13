# 🚀 Telegram Swap Bot — Guía de Deploy

## Resumen

Esta guía cubre cómo poner en producción el SwapBot en Telegram. El bot usa **Boltz API** como backend de swaps (no necesitas nodo Lightning propio), **MongoDB** para tracking, y **Telegraf** como framework de Telegram.

---

## 🔑 Paso 1: Obtener las Credenciales

### 1.1 Token del Bot de Telegram

1. Abre [@BotFather](https://t.me/botfather) en Telegram
2. Envía `/newbot`
3. Dale un nombre: `SwapBot`
4. Dale un username: `tu_swapbot_bot`
5. **Guarda el token** que te da, se ve así: `123456:ABC-DEF1234gh`

**Comandos útiles en BotFather:**
```
/setcommands → Configurar la lista de comandos
/setdescription → Descripción del bot
/setabouttext → Texto "Acerca de"
```

### 1.2 IDs de Admin

1. Abre [@userinfobot](https://t.me/userinfobot) en Telegram
2. Envía `/start` — te da tu ID numérico
3. Repite para cada admin

---

## 💻 Paso 2: Elegir Plataforma

### Opción A: Umbrel (Recomendado si ya tienes uno)

**Prerequisitos:**
- Umbrel OS corriendo
- Acceso SSH a tu Umbrel

**Instalación:**

```bash
# 1. SSH a tu Umbrel
ssh umbrel@umbrel.local
# o
ssh umbrel@<ip-de-tu-umbrel>

# 2. Clonar el repo
cd ~/umbrel
mkdir -p apps/swapbot
cd apps/swapbot

# 3. Clonar
git clone https://github.com/j5002la-collab/telegram-swap-bot.git .
```

**Opción con Docker en Umbrel:**

```bash
# 1. Crear archivo .env
cat > .env << 'EOF'
BOT_TOKEN=tu_token_aqui
MONGO_URI=mongodb://mongo:27017/telegram-swap-bot
BOLTZ_API_URL=https://api.boltz.exchange
COMMISSION_RATE=2.5
ADMIN_IDS=123456789
LOG_LEVEL=info
EOF

# 2. Levantar con Docker Compose
docker compose up -d

# 3. Ver logs
docker compose logs -f swapbot

# 4. Verificar que está corriendo
docker compose ps
```

### Opción B: VPS (DigitalOcean, Hetzner, etc.)

**Prerequisitos:**
- Ubuntu 22.04 o 24.04
- 1GB RAM mínimo (2GB recomendado)
- 20GB disco

```bash
# 1. Actualizar sistema
sudo apt update && sudo apt upgrade -y

# 2. Instalar Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 3. Instalar Docker + Docker Compose
sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER
# Cerrar y volver a abrir sesión SSH

# 4. Instalar git
sudo apt install -y git

# 5. Clonar el repo
cd ~
git clone https://github.com/j5002la-collab/telegram-swap-bot.git
cd telegram-swap-bot

# 6. Crear .env
cat > .env << 'EOF'
BOT_TOKEN=tu_token_aqui
MONGO_URI=mongodb://mongo:27017/telegram-swap-bot
BOLTZ_API_URL=https://api.boltz.exchange
COMMISSION_RATE=2.5
ADMIN_IDS=123456789
LOG_LEVEL=info
EOF

# 7. Levantar con Docker Compose
docker compose up -d

# 8. Verificar
docker compose logs -f
```

### Opción C: Sin Docker (Node.js directo)

Requiere MongoDB instalado localmente o en la nube (Atlas).

```bash
# 1. Instalar MongoDB local (Ubuntu)
# O usar MongoDB Atlas (https://mongodb.com/atlas) — plan gratuito

# 2. Clonar e instalar
git clone https://github.com/j5002la-collab/telegram-swap-bot.git
cd telegram-swap-bot
cp .env-sample .env
nano .env   # Editar con tus valores
npm install
npm run build
npm start
```

---

## ⚙️ Paso 3: Variables de Entorno

Copia `.env-sample` a `.env` y configura:

| Variable | Descripción | Ejemplo |
|---|---|---|
| `BOT_TOKEN` | **Obligatorio**. Token del bot de Telegram | `123456:ABC-DEF` |
| `MONGO_URI` | URI de MongoDB | `mongodb://localhost:27017/telegram-swap-bot` |
| `BOLTZ_API_URL` | API de Boltz (no cambiar) | `https://api.boltz.exchange` |
| `COMMISSION_RATE` | Comisión inicial (1.5-2.5) | `2.5` |
| `ADMIN_IDS` | IDs de Telegram de admins (coma) | `123456,789012` |
| `LOG_LEVEL` | Nivel de logs | `info` (o `debug`) |

---

## ⚙️ Paso 4: Configurar Comandos en BotFather

Envía a @BotFather:

```
/setcommands
@tu_swapbot_bot

swap - Iniciar un intercambio USDT/BTC
rates - Ver tasas en vivo
raffle - Información del sorteo semanal
help - Ayuda
start - Menú principal
```

Y configura la descripción:

```
/setdescription
@tu_swapbot_bot

SwapBot — Intercambios instantáneos USDT/USDC ↔ BTC/Lightning. No-custodial vía Boltz.
```

---

## 📊 Paso 5: Verificar que Funciona

1. Abre tu bot en Telegram: `https://t.me/tu_swapbot_bot`
2. Envía `/start` → Deberías ver el menú
3. Envía `/rates` → Deberías ver las tasas en vivo
4. Intenta `/swap` → Flujo de swap simulado

---

## 🔄 Paso 6: Actualizar

```bash
# Con Docker Compose
cd telegram-swap-bot
git pull
docker compose down
docker compose up -d --build

# Sin Docker
cd telegram-swap-bot
git pull
npm install
npm run build
npm start
```

---

## 🛡️ Monitoreo

```bash
# Ver logs en tiempo real
docker compose logs -f swapbot

# Ver estadísticas de Docker
docker stats

# Verificar MongoDB
docker exec swapbot-mongo mongosh --eval "db.adminCommand('ping')"
```

---

## 🧪 Troubleshooting

| Problema | Solución |
|---|---|
| Bot no responde | Verifica `BOT_TOKEN` en `.env` |
| Error MongoDB | Asegúrate que `MONGO_URI` sea correcto y accesible |
| Error Boltz | Prueba `curl https://api.boltz.exchange/v2/swap/submarine` |
| "Comisión debe ser 1.5-2.5" | Usa `/admin fee 2.5` en Telegram |
| Puerto 27017 ocupado | Cambia el puerto en `docker-compose.yml` |

---

## ☁️ MongoDB Atlas (Alternativa Gratis)

Si no quieres manejar MongoDB local:

1. Crea cuenta en [mongodb.com/atlas](https://mongodb.com/atlas)
2. Crea un cluster (Free Tier M0)
3. Crea un usuario de base de datos
4. Obtén la connection string:
   ```
   mongodb+srv://usuario:password@cluster.mongodb.net/telegram-swap-bot?retryWrites=true&w=majority
   ```
5. Pónla en `MONGO_URI` en tu `.env`

---

## 📱 Opción: Ejecutar 24/7 sin Servidor

Si no tienes Umbrel ni VPS:

- **Railway.app** — $5/mes, despliegue con un click desde GitHub
- **Render.com** — Free tier (se duerme después de inactividad)
- **Fly.io** — Free tier con 3 VMs compartidas

Cualquiera de estas plataformas puede desplegar el `Dockerfile` directamente.

---

¿Preguntas? Abre un issue en el repo.
