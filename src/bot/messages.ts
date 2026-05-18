import { Markup } from 'telegraf';

// --- Main Menu ---
export const MAIN_MENU_KEYBOARD = Markup.inlineKeyboard([
  [Markup.button.callback('🔄 Iniciar Swap', 'start_swap')],
  [
    Markup.button.callback('🧮 Calculadora', 'show_calc'),
    Markup.button.callback('📊 Tasas', 'show_rates'),
  ],
  [
    Markup.button.callback('🎁 Sorteo', 'show_raffle'),
    Markup.button.callback('❓ Ayuda', 'show_help'),
  ],
]);

// --- Swap Flow Messages ---
export const SWAP_MESSAGES = {
  chooseDirection: '¿Qué tipo de intercambio?',
  cancelled: 'Cancelado.',
  sessionExpired: 'Sesión expirada. Usa /swap.',
  invalidAmount: 'Monto inválido. Solo números enteros.',
  enterAddress: (coin: string) => `Pega tu dirección ${coin} donde recibirás:`,
  confirmSummary: (send: string, receive: string, fee: string, time: string) =>
    `📋 *Resumen del swap*\n\n` +
    `Envías: ${send}\n` +
    `Recibes: ${receive}\n` +
    `Comisión: ${fee}\n` +
    `⏱ ${time}`,
  swapCreated: (id: string) => `✅ Swap creado\n\nID: \`${id}\``,
  swapFailed: '❌ Swap no completado. Intenta de nuevo.',
  swapCompleted: (id: string, sent: string, received: string) =>
    `🎉 *¡Swap completado!*\n\n` +
    `Enviaste: ${sent}\n` +
    `Recibiste: ${received}\n` +
    `ID: \`${id}\`\n\n` +
    'Usa /swap para un nuevo intercambio.',
};

// --- Admin Messages ---
export const ADMIN_MESSAGES = {
  unauthorized: '⛔ No autorizado.',
  help: `🤖 *Admin Panel*\n\n` +
    '/admin volume — Estadísticas\n' +
    '/admin swaps — Últimos swaps\n' +
    '/admin pending — Pendientes\n' +
    '/admin cancel ID — Cancelar\n' +
    '/admin users — Usuarios\n' +
    '/admin fee X — Comisión\n' +
    '/admin raffle — Sorteo\n' +
    '/admin treasury — Balance\n' +
    '/admin withdraw X — Retiro\n' +
    '/admin broadcast — Broadcast\n' +
    '/admin pro on|off — Pro Mode',
};

export function buildConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Confirmar', 'swap_confirm'),
      Markup.button.callback('❌ Cancelar', 'swap_cancel'),
    ],
  ]);
}
