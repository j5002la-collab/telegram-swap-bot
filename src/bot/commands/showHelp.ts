import { Context } from 'telegraf';

export async function showHelp(ctx: Context): Promise<void> {
  const helpMessage = `📋 *Comandos disponibles*

/start — Menú principal
/swap — Iniciar un intercambio
/rates — Ver tasas actuales
/raffle — Información del sorteo
/help — Esta ayuda

*¿Cómo funciona?*
1\\. Selecciona /swap
2\\. Elige dirección \\(USDT→BTC, BTC→USDT, etc\\.\\)
3\\. Ingresa el monto
4\\. Revisa las comisiones
5\\. Confirma y el bot hace el resto

*Soporte:* @admin`;

  await ctx.reply(helpMessage);
}
