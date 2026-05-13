import { Markup } from 'telegraf';

/**
 * Centralized message templates for the Telegram Swap Bot.
 * All user-facing strings in Spanish (primary) with i18n support in future.
 */

// --- Main Menu ---
export const MENU_BUTTONS = {
  swap: '🔄 Iniciar Swap',
  rates: '📊 Tasas',
  raffle: '🎁 Sorteo',
  help: '❓ Ayuda',
  cancel: '❌ Cancelar',
  confirm: '✅ Confirmar swap',
  back: '🔙 Volver',
  refresh: '🔄 Actualizar tasas',
};

export const MAIN_MENU_KEYBOARD = Markup.inlineKeyboard([
  [Markup.button.callback(MENU_BUTTONS.swap, 'start_swap')],
  [
    Markup.button.callback(MENU_BUTTONS.rates, 'show_rates'),
    Markup.button.callback(MENU_BUTTONS.raffle, 'show_raffle'),
  ],
  [Markup.button.callback(MENU_BUTTONS.help, 'show_help')],
]);

// --- Swap Flow ---
export const SWAP_MESSAGES = {
  chooseDirection: '🔄 *¿Qué quieres convertir?*\n\nSelecciona la dirección del swap:',
  cancelled: '❌ Swap cancelado.',
  sessionExpired: '⚠️ Sesión expirada. Usa /swap para empezar de nuevo.',
  processing: '⏳ *Procesando tu swap...*\n\nEsto puede tomar 1-5 minutos.',
  invalidAmount: '⚠️ *Monto inválido.*\n\nPor favor ingresa solo números enteros (ej: 50000). Los montos son en la unidad más pequeña.',
  amountTooLow: (min: number) => `⚠️ *Monto muy bajo.*\n\nEl monto mínimo es ${min.toLocaleString()} unidades.`,
  amountTooHigh: (max: number) => `⚠️ *Monto muy alto.*\n\nEl monto máximo es ${max.toLocaleString()} unidades.`,
  ratesUnavailable: '⚠️ *No se pudieron obtener las tasas.*\n\nEl servicio de intercambio puede estar temporalmente no disponible. Intenta de nuevo en unos minutos.',
  ratesError: '❌ *Error al obtener tasas.*\n\nIntenta de nuevo en unos minutos.',
  swapSuccess: (swapId: string) => `✅ *¡Swap completado!*\n\nID: ${swapId}`,
  swapError: '❌ *Error en el swap.*\n\nIntenta de nuevo con /swap. Si el problema persiste, contacta a @admin.',
  enterAmount: (minLabel: string, maxLabel: string) => `💬 Ingresa el monto que quieres convertir:\n\nMín: ${minLabel}\nMáx: ${maxLabel}\n\nResponde directamente con el número (solo números, sin comas ni puntos)`,
};

// --- Rates ---
export const RATES_MESSAGES = {
  loading: '⏳ Cargando tasas en vivo...',
  updating: 'Actualizando...',
  header: (commission: number) => `📊 *Tasas en vivo*\n\nComisión SwapBot: ${commission}%\n`,
};

// --- Raffle ---
export const RAFFLE_MESSAGES = {
  notActive: '⚠️ No hay sorteo activo en este momento.',
  error: '⚠️ Error al obtener información del sorteo.',
  noWinners: '📜 Aún no hay ganadores registrados.',
  winnersError: '⚠️ Error al cargar ganadores.',
};

// --- Admin ---
export const ADMIN_MESSAGES = {
  unauthorized: '⛔ No tienes permisos de administrador.',
  help: `🤖 *Admin Panel*\n\n/admin volume — Volumen y ganancias\n/admin swaps — Últimos 20 swaps\n/admin users — Usuarios activos\n/admin fee 1.8 — Cambiar comisión (1.5-2.5)\n/admin raffle — Estado del sorteo\n/admin broadcast — Enviar a todos`,
  generalError: '⚠️ Error.',
  volumeError: '⚠️ Error al obtener estadísticas.',
  swapsError: '⚠️ Error al obtener swaps.',
  swapsNone: '📋 No hay swaps registrados aún.',
  usersError: '⚠️ Error al obtener usuarios.',
  feeCurrent: (rate: number) => `💸 Comisión actual: *${rate}%*\n\nUso: \`/admin fee 1.8\` (entre 1.5 y 2.5)`,
  feeUsage: '⚠️ El valor debe ser un número (ej: 1.8).',
  feeUpdated: (rate: number) => `✅ Comisión actualizada a *${rate}%*`,
  broadcastUsage: '⚠️ Uso: `/admin broadcast Mensaje a enviar a todos los usuarios`',
  broadcastProgress: (count: number) => `📢 Enviando broadcast a ${count} usuarios...`,
  broadcastDone: (sent: number, failed: number) => `📢 *Broadcast completado*\n\n✅ Enviados: ${sent}\n❌ Fallidos: ${failed}`,
  raffleNone: '⚠️ No hay sorteo activo.',
  raffleDrawSuccess: (week: number, winner: string, prize: number, tickets: number, participants: number) => `🎯 *Sorteo ejecutado!*\n\nSemana: ${week}\nGanador: @${winner}\nPremio: ${prize.toLocaleString()} sats\nTickets: ${tickets}\nParticipantes: ${participants}`,
  raffleAlreadyDrawn: '⚠️ El sorteo ya fue ejecutado o no hay participantes.',
  raffleError: '⚠️ Error al ejecutar sorteo.',
};

// --- Swap Direction ---
export const SWAP_DIRECTIONS = {
  usdt2btc: { key: 'usdt2btc', label: '💎 USDT → BTC (Lightning)', action: 'swap_dir_usdt2btc' },
  btc2usdt: { key: 'btc2usdt', label: '₿ BTC (Lightning) → USDT', action: 'swap_dir_btc2usdt' },
  usdc2btc: { key: 'usdc2btc', label: '💵 USDC → BTC (Lightning)', action: 'swap_dir_usdc2btc' },
  btc2usdc: { key: 'btc2usdc', label: '₿ BTC (Lightning) → USDC', action: 'swap_dir_btc2usdc' },
} as const;

export function buildSwapDirectionKeyboard() {
  const rows = Object.values(SWAP_DIRECTIONS).map((d) => [
    Markup.button.callback(d.label, d.action),
  ]);
  rows.push([Markup.button.callback('❌ Cancelar', 'swap_cancel')]);
  return Markup.inlineKeyboard(rows);
}

export function buildConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Confirmar swap', 'swap_confirm'),
      Markup.button.callback('❌ Cancelar', 'swap_cancel'),
    ],
  ]);
}
