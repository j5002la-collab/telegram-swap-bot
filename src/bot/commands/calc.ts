import { Context, Markup } from 'telegraf';
import { rateEngine } from '../../engine/rates';
import { commissionEngine } from '../../engine/commission';
import { raffleEngine } from '../../engine/raffle';
import { logger } from '../../utils/logger';

export async function calcCommand(ctx: Context): Promise<void> {
  await ctx.reply(
    '🧮 *Calculadora SwapBot*\n\n' +
    'Ingresa el monto en sats y te muestro\n' +
    'cuánto recibirás en ambos sentidos:\n\n' +
    '• BTC On-chain → Lightning\n' +
    '• Lightning → BTC On-chain\n\n' +
    'Comisión SwapBot: ' + commissionEngine.getCommissionRate() + '%\n\n' +
    'Ejemplo: `100000`',
  );
}

export async function handleCalcText(ctx: Context, next: () => Promise<void>): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) return next();

  const raw = ctx.message.text.trim();
  const amount = parseInt(raw, 10);
  if (isNaN(amount) || amount <= 0) return next();

  try {
    const [subRate, revRate] = await Promise.all([
      rateEngine.getRate('submarine', 'BTC', 'BTC'),
      rateEngine.getRate('reverse', 'BTC', 'BTC'),
    ]);

    const commission = commissionEngine.getCommissionRate();
    const raffleStatus = await raffleEngine.getRaffleStatus();
    const lines = ['🧮 *Calculadora SwapBot*\n'];

    // Both directions
    if (subRate) {
      const fee = commissionEngine.calculateFeeBreakdown(amount, subRate);
      lines.push('*BTC On-chain → Lightning*');
      lines.push(`Envías:  ${amount.toLocaleString()} sats`);
      lines.push(`Recibes: ~${fee.estimatedReceive.toLocaleString()} sats`);
      lines.push(`Fee red: ${fee.boltzFeeAmount.toLocaleString()} sats (${fee.boltzFeeRate}%)`);
      lines.push(`Comisión: ${fee.commissionAmount.toLocaleString()} sats`);
      lines.push('');
    }

    if (revRate) {
      const fee = commissionEngine.calculateFeeBreakdown(amount, revRate);
      lines.push('*Lightning → BTC On-chain*');
      lines.push(`Envías:  ${amount.toLocaleString()} sats`);
      lines.push(`Recibes: ~${fee.estimatedReceive.toLocaleString()} sats`);
      lines.push(`Fee red: ${fee.boltzFeeAmount.toLocaleString()} sats (${fee.boltzFeeRate}%)`);
      lines.push(`Comisión: ${fee.commissionAmount.toLocaleString()} sats`);
      lines.push('');
    }

    if (!subRate && !revRate) {
      lines.push('⚠️ No se pudieron obtener tasas.');
    }

    // Raffle
    if (raffleStatus) {
      const raffleAmount = Math.floor(amount * 0.001);
      lines.push(`🎁 Sorteo semanal (0.1%): ${raffleAmount} sats`);
      lines.push(`   Premio acumulado: ${raffleStatus.prizePool.toLocaleString()} sats`);
    }

    lines.push(`\nComisión SwapBot: ${commission}%`);

    await ctx.reply(
      lines.join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Hacer swap con ' + amount.toLocaleString() + ' sats', 'start_swap')],
        [Markup.button.callback('🧮 Otro monto', 'show_calc')],
      ]),
    );
  } catch (error) {
    logger.error('Calc error', { error });
    await ctx.reply('Error al conectar. Intenta de nuevo.');
  }
}
