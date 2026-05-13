import { Context, Markup } from 'telegraf';
import { rateEngine } from '../../engine/rates';
import { commissionEngine } from '../../engine/commission';
import { logger } from '../../utils/logger';

const DISPLAY_PAIRS = [
  { label: 'USDT → BTC (Lightning)', from: 'USDT', to: 'BTC', swapType: 'submarine' as const, emoji: '💎' },
  { label: 'BTC (Lightning) → USDT', from: 'BTC', to: 'USDT', swapType: 'reverse' as const, emoji: '₿' },
  { label: 'USDC → BTC (Lightning)', from: 'USDC', to: 'BTC', swapType: 'submarine' as const, emoji: '💵' },
  { label: 'BTC (Lightning) → USDC', from: 'BTC', to: 'USDC', swapType: 'reverse' as const, emoji: '₿' },
];

export async function ratesCommand(ctx: Context): Promise<void> {
  const loadingMsg = await ctx.reply('⏳ Cargando tasas en vivo\\.\\.\\.');

  const lines: string[] = ['📊 *Tasas en vivo*', '', `Comisión SwapBot: ${commissionEngine.getCommissionRate()}%`, ''];

  for (const pair of DISPLAY_PAIRS) {
    try {
      const rateInfo = await rateEngine.getRate(pair.swapType, pair.from, pair.to);
      if (rateInfo) {
        lines.push(`${pair.emoji} *${pair.label}*`);
        lines.push(`  Tasa: 1 → ${rateInfo.userRate.toFixed(2)}`);
        lines.push(`  Mín: ${rateInfo.minAmount.toLocaleString()} | Máx: ${rateInfo.maxAmount.toLocaleString()}`);
        lines.push('');
      }
    } catch (error) {
      logger.error('Rate fetch failed for display', { pair: pair.label, error });
      lines.push(`${pair.emoji} *${pair.label}* — No disponible`);
      lines.push('');
    }
  }

  lines.push('⏱ Tasas actualizadas cada 30 segundos\\.');

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Actualizar tasas', 'refresh_rates')],
    [Markup.button.callback('🔄 Iniciar swap', 'start_swap')],
  ]);

  try {
    await ctx.deleteMessage(loadingMsg.message_id);
  } catch {
    // Ignore if message can't be deleted
  }

  await ctx.replyWithMarkdownV2(lines.join('\n'), keyboard);
}

export async function handleRefreshRates(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  await ctx.answerCbQuery('Actualizando...');

  // Fetch fresh rates (bypass cache by not reusing the old one)
  const lines: string[] = ['📊 *Tasas actualizadas*', '', `Comisión SwapBot: ${commissionEngine.getCommissionRate()}%`, ''];

  for (const pair of DISPLAY_PAIRS) {
    try {
      const rateInfo = await rateEngine.getRate(pair.swapType, pair.from, pair.to);
      if (rateInfo) {
        lines.push(`${pair.emoji} *${pair.label}*`);
        lines.push(`  Tasa: 1 → ${rateInfo.userRate.toFixed(2)}`);
        lines.push(`  Mín: ${rateInfo.minAmount.toLocaleString()} | Máx: ${rateInfo.maxAmount.toLocaleString()}`);
        lines.push('');
      }
    } catch {
      lines.push(`${pair.emoji} *${pair.label}* — No disponible`);
      lines.push('');
    }
  }

  lines.push(`Actualizado: ${new Date().toLocaleTimeString()}`);

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Actualizar tasas', 'refresh_rates')],
    [Markup.button.callback('🔄 Iniciar swap', 'start_swap')],
  ]);

  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
}
