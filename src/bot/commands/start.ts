import { Context, Markup } from 'telegraf';
import { getUserState } from '../middleware/user';
import { showHelp } from './showHelp';
import { commissionEngine } from '../../engine/commission';
import { swapCommand } from './swap';
import { calcCommand } from './calc';
import { raffleCommand } from './raffle';

export async function startCommand(ctx: Context): Promise<void> {
  const firstName = ctx.from?.first_name || 'User';
  const userState = getUserState(ctx);
  const username = userState?.username || firstName;
  const rate = commissionEngine.getCommissionRate();

  const welcomeMessage = 'SwapBot — Cambios instantaneos BTC/Lightning\n\n' +
    'Comision: ' + rate + '% (configurable 1.5%-2.5%)\n' +
    'Sorteo semanal: 0.1% del volumen\n\n' +
    'Selecciona una opcion:';

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('Iniciar Swap', 'start_swap')],
    [
      Markup.button.callback('Calculadora', 'show_calc'),
      Markup.button.callback('Sorteo', 'show_raffle'),
    ],
    [Markup.button.callback('Ayuda', 'show_help')],
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
    case 'show_calc':
      await ctx.answerCbQuery();
      await calcCommand(ctx);
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
