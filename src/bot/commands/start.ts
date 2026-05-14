import { Context, Markup } from 'telegraf';
import { getUserState } from '../middleware/user';
import { showHelp } from './showHelp';
import { commissionEngine } from '../../engine/commission';
import { rateEngine } from '../../engine/rates';
import { logger } from '../../utils/logger';
import { MAIN_MENU_KEYBOARD } from '../messages';
import { swapCommand } from './swap';
import { calcCommand } from './calc';
import { raffleCommand } from './raffle';

export async function startCommand(ctx: Context): Promise<void> {
  const firstName = ctx.from?.first_name || 'User';
  const userState = getUserState(ctx);
  const username = userState?.username || firstName;
  const rate = commissionEngine.getCommissionRate();

  const welcomeMessage = 'SwapBot — Cambios instantáneos BTC/Lightning\n\n' +
    'Comisión: ' + rate + '% (configurable 1.5%-2.5%)\n' +
    'Sorteo semanal: 0.1% del volumen\n\n' +
    'Selecciona una opción:';

  await ctx.reply(welcomeMessage, MAIN_MENU_KEYBOARD);
}

export async function showRates(ctx: Context): Promise<void> {
  try {
    const isCallback = ctx.callbackQuery && 'data' in ctx.callbackQuery;

    if (isCallback) {
      await ctx.editMessageText('⏳ Cargando tasas en vivo...');
    } else {
      await ctx.reply('⏳ Cargando tasas en vivo...');
    }

    const [subRate, revRate] = await Promise.all([
      rateEngine.getRate('submarine', 'BTC', 'BTC'),
      rateEngine.getRate('reverse', 'BTC', 'BTC'),
    ]);

    const commission = commissionEngine.getCommissionRate();

    const lines = [
      `📊 *Tasas en vivo*`,
      '',
      `Comisión SwapBot: ${commission}%`,
      '',
    ];

    if (subRate) {
      lines.push('*BTC On-chain → Lightning:*');
      lines.push(`  Tasa: 1 BTC = ${(subRate.userRate).toFixed(8)} BTC (Lightning)`);
      lines.push(`  Fee red: ${subRate.boltzFeePct}% + ${subRate.boltzMinerFee} sats`);
      lines.push(`  Mín: ${subRate.minAmount.toLocaleString()} sats | Máx: ${subRate.maxAmount.toLocaleString()} sats`);
      lines.push('');
    }

    if (revRate) {
      lines.push('*Lightning → BTC On-chain:*');
      lines.push(`  Tasa: 1 BTC (Lightning) = ${(revRate.userRate).toFixed(8)} BTC`);
      lines.push(`  Fee red: ${revRate.boltzFeePct}% + ${revRate.boltzMinerFee} sats`);
      lines.push(`  Mín: ${revRate.minAmount.toLocaleString()} sats | Máx: ${revRate.maxAmount.toLocaleString()} sats`);
    }

    if (!subRate && !revRate) {
      lines.push('⚠️ No se pudieron obtener las tasas. Intenta de nuevo.');
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Actualizar', 'show_rates')],
      [Markup.button.callback('🔙 Volver al menú', 'show_help')],
    ]);

    if (isCallback) {
      await ctx.editMessageText(lines.join('\n'), keyboard);
    } else {
      await ctx.reply(lines.join('\n'), keyboard);
    }
  } catch (error) {
    logger.error('Rates display error', { error });
    await ctx.reply('⚠️ Error al obtener tasas. Intenta de nuevo.');
  }
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
    case 'show_rates':
      await ctx.answerCbQuery();
      await showRates(ctx);
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
