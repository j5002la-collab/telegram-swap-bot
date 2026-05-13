import { Context, Markup } from 'telegraf';
import { getUserState } from '../middleware/user';

export async function startCommand(ctx: Context): Promise<void> {
  const firstName = ctx.from?.first_name || 'User';
  const userState = getUserState(ctx);
  const username = userState?.username || firstName;

  const welcomeMessage = `🤖 ¡Bienvenido, ${username}!

Soy SwapBot, tu intermediario para intercambios instantáneos de USDT/USDC ↔ BTC/Lightning.

📍 **No-custodial** — Nunca retengo tus fondos
⚡ **Instantáneo** — Swaps en 1-5 minutos
💸 **Comisión transparente** — 2.5%
🎁 **Sorteo semanal** — 0.1% del volumen

Selecciona una opción para empezar:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Iniciar Swap', 'start_swap')],
    [Markup.button.callback('📊 Tasas', 'show_rates'), Markup.button.callback('🎁 Sorteo', 'show_raffle')],
    [Markup.button.callback('❓ Ayuda', 'show_help')],
  ]);

  await ctx.replyWithMarkdown(welcomeMessage, keyboard);
}

export async function handleStartCallback(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;

  const action = ctx.callbackQuery.data;

  switch (action) {
    case 'start_swap':
      await ctx.answerCbQuery();
      // TODO: redirect to swap flow (Phase 2)
      await ctx.reply('🔄 Función de swap en construcción. Pronto disponible.');
      break;
    case 'show_rates':
      await ctx.answerCbQuery();
      // TODO: show rates (Phase 4)
      await ctx.reply('📊 Tasas en construcción. Pronto disponible.');
      break;
    case 'show_raffle':
      await ctx.answerCbQuery();
      // TODO: show raffle (Phase 4)
      await ctx.reply('🎁 Sorteo semanal en construcción. Pronto disponible.');
      break;
    case 'show_help':
      await ctx.answerCbQuery();
      await showHelp(ctx);
      break;
    default:
      await ctx.answerCbQuery();
  }
}

export async function showHelp(ctx: Context): Promise<void> {
  const helpMessage = `📋 **Comandos disponibles**

/start — Menú principal
/swap — Iniciar un intercambio
/rates — Ver tasas actuales
/raffle — Información del sorteo
/help — Esta ayuda

**¿Cómo funciona?**
1. Selecciona /swap
2. Elige dirección (USDT→BTC, BTC→USDT, etc.)
3. Ingresa el monto
4. Revisa las comisiones
5. Confirma y el bot hace el resto

**Soporte:** @admin`;

  await ctx.replyWithMarkdown(helpMessage);
}
