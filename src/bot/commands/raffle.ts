import { Context, Markup } from 'telegraf';
import { raffleEngine } from '../../engine/raffle';
import { commissionEngine } from '../../engine/commission';
import { logger } from '../../utils/logger';
import { Raffle } from '../../models';

export async function raffleCommand(ctx: Context): Promise<void> {
  try {
    const status = await raffleEngine.getRaffleStatus();

    if (!status) {
      await ctx.reply('⚠️ No hay sorteo activo en este momento.');
      return;
    }

    const prizeInBtc = status.prizePool / 100_000_000;
    const volumeInBtc = status.totalVolume / 100_000_000;

    const lines = [
      `🎁 *Sorteo Semanal SwapBot*`,
      '',
      `📅 Semana: ${status.weekNumber}`,
      `💰 Premio acumulado: ${status.prizePool.toLocaleString()} sats \\(${prizeInBtc.toFixed(8)} BTC\\)`,
      `📊 Volumen semanal: ${volumeInBtc.toFixed(4)} BTC`,
      `👥 Participantes: ${status.participants}`,
      `🎫 Porcentaje: 0\\.1% del volumen`,
      '',
    ];

    if (status.lastWinner && status.lastDrawAt) {
      const date = status.lastDrawAt.toLocaleDateString('es-ES');
      lines.push(`🏆 *Último ganador:* @${status.lastWinner} — ${date}`);
      lines.push('');
    }

    lines.push('Cada swap que hagas te da 1 ticket\\.');
    lines.push('¡Más swaps \\= más chances de ganar\\!');
    lines.push('');
    lines.push(`📌 Próximo sorteo: Domingo 23:59 UTC`);

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Iniciar swap', 'start_swap'),
        Markup.button.callback('📜 Ver ganadores', 'raffle_winners'),
      ],
    ]);

    await ctx.replyWithMarkdownV2(lines.join('\n'), keyboard);
  } catch (error) {
    logger.error('Raffle command error', { error });
    await ctx.reply('⚠️ Error al obtener información del sorteo.');
  }
}

export async function handleRaffleWinners(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  await ctx.answerCbQuery();

  try {
    const recentRaffles = await Raffle.find({ paid: true })
      .sort({ weekNumber: -1 })
      .limit(5);

    if (recentRaffles.length === 0) {
      await ctx.editMessageText('📜 Aún no hay ganadores registrados\\.');
      return;
    }

    const lines = ['📜 *Últimos ganadores*', ''];

    for (const r of recentRaffles) {
      const prizeBtc = r.prizePool / 100_000_000;
      const date = r.drawAt?.toLocaleDateString('es-ES') || '?';
      lines.push(
        `🏆 Sem ${r.weekNumber} — @${r.winnerUsername || '?'} — ${r.prizePool.toLocaleString()} sats \\(${prizeBtc.toFixed(8)} BTC\\) — ${date}`,
      );
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Volver', 'show_raffle')],
    ]);

    await ctx.editMessageText(lines.join('\n'), { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
  } catch (error) {
    logger.error('Raffle winners error', { error });
    await ctx.editMessageText('⚠️ Error al cargar ganadores.');
  }
}
