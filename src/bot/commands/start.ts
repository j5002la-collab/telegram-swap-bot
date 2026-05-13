import { Context, Markup } from 'telegraf';
import { getUserState } from '../middleware/user';
import { showHelp } from './showHelp';
import { commissionEngine } from '../../engine/commission';
import { swapCommand } from './swap';
import { raffleCommand } from './raffle';

export async function startCommand(ctx: Context): Promise<void> {
  const firstName = ctx.from?.first_name || 'User';
  const userState = getUserState(ctx);
  const username = userState?.username || firstName;
  const rate = commissionEngine.getCommissionRate();

  const welcomeMessage = `🤖 Bienvenido, ${username}!

Soy SwapBot, tu intermediario para intercambios instantáneos de USDT/USDC ↔ BTC/Lightning.

📍 No-custodial — Nunca retengo tus fondos
⚡ Instantáneo — Swaps en 1-5 minutos
💸 Comisión — ${rate}% (configurable 1.5% - 2.5%)
🎁 Sorteo semanal — 0.1% del volumen

Selecciona una opción para empezar:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Iniciar Swap', 'start_swap')],
    [
      Markup.button.callback('📊 Tasas', 'show_rates'),
      Markup.button.callback('🎁 Sorteo', 'show_raffle'),
    ],
    [Markup.button.callback('❓ Ayuda', 'show_help')],
  ]);

  await ctx.reply(welcomeMessage, keyboard);
}

export async function handleStartCallback(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;

  const action = ctx.callbackQuery.data;

  switch (action) {
    case 'start_swap':
      await ctx.answerCbQuery();
      await swapCommand(ctx);
      break;
    case 'show_rates':
      await ctx.answerCbQuery();
      await ctx.reply('Usa /rates para ver las tasas en vivo.');
      break;
    case 'show_raffle':
      await ctx.answerCbQuery();
      await raffleCommand(ctx);
      break;
    case 'show_help':
      await ctx.answerCbQuery();
      await showHelp(ctx);
      break;
    default:
      await ctx.answerCbQuery();
  }
}
