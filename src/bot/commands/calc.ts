import { Context, Markup } from 'telegraf';
import { rateEngine, RateInfo } from '../../engine/rates';
import { commissionEngine } from '../../engine/commission';
import { raffleEngine } from '../../engine/raffle';
import { logger } from '../../utils/logger';

// BTC pairs that always exist on Boltz
const PAIRS = [
  { label: 'BTC On-chain → Lightning', from: 'BTC', to: 'BTC', st: 'submarine' as const },
  { label: 'Lightning → BTC On-chain', from: 'BTC', to: 'BTC', st: 'reverse' as const },
  { label: 'L-BTC → Lightning', from: 'L-BTC', to: 'BTC', st: 'submarine' as const },
];

export async function calcCommand(ctx: Context): Promise<void> {
  await ctx.reply(
    'Calculadora SwapBot\n\n' +
    'Ingresa el monto que quieres convertir y te muestro:\n' +
    '- Cuanto recibiras (con nuestra comision)\n' +
    '- Cuanto va al sorteo semanal\n' +
    '- Premio acumulado del sorteo\n\n' +
    'Ejemplo: 100000\n' +
    '(en sats para BTC, o el monto en USDT/USDC)',
  );
}

export async function handleCalcAmount(ctx: Context): Promise<void> {
  // Only handle if user is in calc mode (we use a simple heuristic: text that is a number after /calc)
  // We'll handle this via a session check
  // For now, /calc just shows the prompt — the actual calculation happens inline
}

export async function handleCalcCallback(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  await ctx.answerCbQuery();

  const action = ctx.callbackQuery.data;

  if (!action.startsWith('calc_')) return;

  const parts = action.split('_');
  if (parts.length < 3) return;

  const pairKey = parts[1]; // 'btc_btc_sub'
  const amount = parseInt(parts[2], 10);

  if (isNaN(amount) || amount <= 0) return;

  try {
    const rateInfo = await rateEngine.getRate('submarine', 'BTC', 'BTC');
    if (!rateInfo) {
      await ctx.editMessageText('No se pudo obtener la tasa. Intenta de nuevo.');
      return;
    }

    const fee = commissionEngine.calculateFeeBreakdown(amount, rateInfo);
    const raffleStatus = await raffleEngine.getRaffleStatus();

    const lines = [
      'Calculadora SwapBot',
      '',
      'Si envias: ' + commissionEngine.formatAmount(amount, 'sats'),
      '',
      'Recibiras: ' + commissionEngine.formatAmount(fee.estimatedReceive, 'sats'),
      '',
      'Desglose:',
      '  Tu comision (' + fee.commissionRate + '%): ' + commissionEngine.formatAmount(fee.commissionAmount, 'sats'),
      '  Fee de red (Boltz): ~' + commissionEngine.formatAmount(fee.boltzFeeAmount + fee.boltzMinerFee, 'sats'),
      '',
      'Al sorteo va: ' + commissionEngine.formatAmount(Math.floor(amount * 0.001), 'sats') + ' (0.1%)',
    ];

    if (raffleStatus) {
      lines.push('');
      lines.push('Premio acumulado sorteo: ' + raffleStatus.prizePool.toLocaleString() + ' sats');
      lines.push('Participantes: ' + raffleStatus.participants);
    }

    lines.push('');
    lines.push('Comision total SwapBot: ' + fee.commissionRate + '% (configurable 1.5%-2.5%)');

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('Ir al swap', 'start_swap')],
    ]);

    await ctx.editMessageText(lines.join('\n'), keyboard);
  } catch (error) {
    logger.error('Calc error', { error });
    await ctx.editMessageText('Error al calcular. Intenta de nuevo.');
  }
}

// Calculator with specific amount input
export async function handleCalcText(ctx: Context): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) return;

  const raw = ctx.message.text.trim();
  const amount = parseInt(raw, 10);

  if (isNaN(amount) || amount <= 0) return;

  try {
    const rateInfo = await rateEngine.getRate('submarine', 'BTC', 'BTC');
    if (!rateInfo) {
      await ctx.reply('No se pudo obtener la tasa. Intenta de nuevo.');
      return;
    }

    const fee = commissionEngine.calculateFeeBreakdown(amount, rateInfo);
    const raffleStatus = await raffleEngine.getRaffleStatus();

    const lines = [
      'Calculadora SwapBot',
      '',
      'Si envias: ' + commissionEngine.formatAmount(amount, 'sats'),
      '',
      'Recibiras: ~' + commissionEngine.formatAmount(fee.estimatedReceive, 'sats'),
      '',
      'Desglose:',
      '  SwapBot (' + fee.commissionRate + '%): ' + commissionEngine.formatAmount(fee.commissionAmount, 'sats'),
      '  Red (~' + fee.boltzFeeRate + '%): ' + commissionEngine.formatAmount(fee.boltzFeeAmount + fee.boltzMinerFee, 'sats'),
      '',
      'Al sorteo (0.1%): ' + commissionEngine.formatAmount(Math.floor(amount * 0.001), 'sats'),
    ];

    if (raffleStatus) {
      lines.push('');
      lines.push('Premio sorteo: ' + raffleStatus.prizePool.toLocaleString() + ' sats (' + raffleStatus.participants + ' participantes)');
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('Ir al swap', 'start_swap')],
    ]);

    await ctx.reply(lines.join('\n'), keyboard);
  } catch (error) {
    logger.error('Calc error', { error });
    await ctx.reply('Error. Intenta de nuevo.');
  }
}
