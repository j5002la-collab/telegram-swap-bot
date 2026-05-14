import { Context, Markup } from 'telegraf';
import { rateEngine } from '../../engine/rates';
import { commissionEngine } from '../../engine/commission';
import { raffleEngine } from '../../engine/raffle';
import { logger } from '../../utils/logger';

export async function calcCommand(ctx: Context): Promise<void> {
  await ctx.reply(
    'Calculadora SwapBot\n\n' +
    'Ingresa el monto en sats y te muestro:\n' +
    '- Cuanto recibirás (descontando todas las desglose de comisiones)\n' +
    '- Comision SwapBot (1.5% - 2.5%)\n' +
    '- Fee de red + mineria\n' +
    '- Cuanto va al sorteo semanal\n\n' +
    'Ejemplo: 100000\n(en sats)',
  );
}

export async function handleCalcText(ctx: Context, next: () => Promise<void>): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) return next();

  const raw = ctx.message.text.trim();
  const amount = parseInt(raw, 10);

  if (isNaN(amount) || amount <= 0) return next();

  try {
    const rateInfo = await rateEngine.getRate('submarine', 'BTC', 'BTC');
    if (!rateInfo) {
      await ctx.reply('No se pudo conectar. Intenta de nuevo.');
      return;
    }

    const fee = commissionEngine.calculateFeeBreakdown(amount, rateInfo);
    const raffleStatus = await raffleEngine.getRaffleStatus();

    const raffleAmount = Math.floor(amount * 0.001);
    const btcAmount = amount / 100_000_000;
    const receiveBTC = fee.estimatedReceive / 100_000_000;

    const lines = [
      'Calculadora SwapBot',
      '',
      'Envias: ' + amount.toLocaleString() + ' sats (' + btcAmount.toFixed(8) + ' BTC)',
      '',
      'Recibirás: ~' + fee.estimatedReceive.toLocaleString() + ' sats (' + receiveBTC.toFixed(8) + ' BTC)',
      '',
      '--- Comisiones ---',
      'SwapBot (' + fee.commissionRate + '%): ' + fee.commissionAmount.toLocaleString() + ' sats',
      'Fee de red (' + fee.boltzFeeRate + '%): ~' + fee.boltzFeeAmount.toLocaleString() + ' sats',
      'Mineria de red: ' + fee.boltzMinerFee.toLocaleString() + ' sats',
      '',
      'Total fees: ' + fee.totalFees.toLocaleString() + ' sats',
      '',
      '--- Sorteo semanal ---',
      'Tu aportas (0.1%): ' + raffleAmount.toLocaleString() + ' sats',
    ];

    if (raffleStatus) {
      lines.push('Premio acumulado: ' + raffleStatus.prizePool.toLocaleString() + ' sats (' + raffleStatus.participants + ' participantes)');
      lines.push('Proximo sorteo: Domingo 23:59 UTC');
    }

    lines.push('');
    lines.push('Swaps instantaneos y seguros.');

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('Ir al swap', 'start_swap')],
    ]);

    await ctx.reply(lines.join('\n'), keyboard);
  } catch (error) {
    logger.error('Calc error', { error });
    await ctx.reply('Error al conectar. Intenta de nuevo.');
  }
}
