import { Context } from 'telegraf';

export async function showHelp(ctx: Context): Promise<void> {
  const helpMessage = '🤖 *SwapBot — Comandos*\n\n' +
    '/start — Menú principal\n' +
    '/swap — Iniciar un intercambio\n' +
    '/rates — Ver tasas en vivo\n' +
    '/calc — Calculadora de comisiones\n' +
    '/raffle — Información del sorteo\n' +
    '/cancel — Cancelar swap en curso\n' +
    '/help — Esta ayuda\n\n' +
    '📋 *Cómo funciona:*\n' +
    '1. Usa /calc para ver cuánto recibirás\n' +
    '2. Usa /swap para hacer el intercambio\n' +
    '3. Pega tu invoice de Lightning o dirección BTC\n' +
    '4. Confirma y listo\n\n' +
    '🆘 Soporte: @admin';

  await ctx.reply(helpMessage);
}
