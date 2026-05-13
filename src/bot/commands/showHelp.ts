import { Context } from 'telegraf';

export async function showHelp(ctx: Context): Promise<void> {
  const helpMessage = 'SwapBot — Comandos\n\n' +
    '/start — Menu principal\n' +
    '/swap — Iniciar un intercambio\n' +
    '/calc — Calculadora: cuanto recibes\n' +
    '/raffle — Informacion del sorteo\n' +
    '/help — Esta ayuda\n\n' +
    'Como funciona?\n' +
    '1. Usa /calc para ver cuanto recibes\n' +
    '2. Usa /swap para hacer el intercambio\n' +
    '3. Pega tu invoice de Lightning\n' +
    '4. Confirma y listo\n\n' +
    'Soporte: @admin';

  await ctx.reply(helpMessage);
}
