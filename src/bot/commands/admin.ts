import { Context, Markup } from 'telegraf';
import { config } from '../../utils/config';
import { logger } from '../../utils/logger';
import { commissionEngine } from '../../engine/commission';
import { raffleEngine } from '../../engine/raffle';
import { forceRaffleDraw } from '../../jobs/raffle-draw';
import { Swap, User } from '../../models';
import { getUserState } from '../middleware/user';

/**
 * Admin authorization middleware check.
 * Returns true if user is admin.
 */
function isAdmin(ctx: Context): boolean {
  const userId = Number(ctx.from?.id);
  return config.adminIds.includes(userId);
}

async function unauthorized(ctx: Context): Promise<void> {
  await ctx.reply('⛔ No tienes permisos de administrador\\.');
}

// --- /admin volume ---
async function adminVolume(ctx: Context): Promise<void> {
  try {
    const now = new Date();

    // Today's stats
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todaySwaps = await Swap.countDocuments({ createdAt: { $gte: todayStart }, status: 'completed' });
    const todayVolume = await Swap.aggregate([
      { $match: { createdAt: { $gte: todayStart }, status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$sourceAmount' }, profit: { $sum: '$botProfit' } } },
    ]);

    // Week stats
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    const weekSwaps = await Swap.countDocuments({ createdAt: { $gte: weekStart }, status: 'completed' });
    const weekVolume = await Swap.aggregate([
      { $match: { createdAt: { $gte: weekStart }, status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$sourceAmount' }, profit: { $sum: '$botProfit' } } },
    ]);

    // All time
    const allSwaps = await Swap.countDocuments({ status: 'completed' });
    const allVolume = await Swap.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$sourceAmount' }, profit: { $sum: '$botProfit' } } },
    ]);

    const todayProfit = todayVolume[0]?.profit || 0;
    const weekProfit = weekVolume[0]?.profit || 0;
    const allProfit = allVolume[0]?.profit || 0;

    const lines = [
      `📊 *Estadísticas del Bot*`,
      '',
      `*Hoy:*`,
      `  Swaps: ${todaySwaps}`,
      `  Ganancia: ${commissionEngine.formatAmount(todayProfit, 'sats')}`,
      '',
      `*Esta semana:*`,
      `  Swaps: ${weekSwaps}`,
      `  Ganancia: ${commissionEngine.formatAmount(weekProfit, 'sats')}`,
      '',
      `*Total histórico:*`,
      `  Swaps: ${allSwaps}`,
      `  Ganancia: ${commissionEngine.formatAmount(allProfit, 'sats')}`,
      '',
      `Comisión actual: ${commissionEngine.getCommissionRate()}%`,
    ];

    await ctx.replyWithMarkdownV2(lines.join('\n'));
  } catch (error) {
    logger.error('Admin volume error', { error });
    await ctx.reply('⚠️ Error al obtener estadísticas\\.');
  }
}

// --- /admin swaps ---
async function adminSwaps(ctx: Context): Promise<void> {
  try {
    const recentSwaps = await Swap.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .select('swapId userId direction sourceAmount sourceCurrency destAmount destCurrency commissionAmount botProfit status createdAt');

    if (recentSwaps.length === 0) {
      await ctx.reply('📋 No hay swaps registrados aún\\.');
      return;
    }

    const lines = ['📋 *Últimos 20 Swaps*', ''];

    for (const s of recentSwaps) {
      const statusEmoji = s.status === 'completed' ? '✅' : s.status === 'failed' ? '❌' : s.status === 'refunded' ? '↩️' : '⏳';
      lines.push(
        `${statusEmoji} \`${s.swapId}\` ${s.direction} — ${s.commissionAmount} profit — ${s.createdAt.toISOString().slice(0, 19)}`,
      );
    }

    await ctx.replyWithMarkdownV2(lines.join('\n'));
  } catch (error) {
    logger.error('Admin swaps error', { error });
    await ctx.reply('⚠️ Error al obtener swaps\\.');
  }
}

// --- /admin users ---
async function adminUsers(ctx: Context): Promise<void> {
  try {
    const totalUsers = await User.countDocuments();
    const activeToday = await User.countDocuments({
      lastSeen: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });
    const activeWeek = await User.countDocuments({
      lastSeen: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    });

    const lines = [
      `👥 *Estadísticas de Usuarios*`,
      '',
      `Total registrados: ${totalUsers}`,
      `Activos hoy: ${activeToday}`,
      `Activos esta semana: ${activeWeek}`,
    ];

    await ctx.replyWithMarkdownV2(lines.join('\n'));
  } catch (error) {
    logger.error('Admin users error', { error });
    await ctx.reply('⚠️ Error al obtener usuarios\\.');
  }
}

// --- /admin fee <rate> ---
async function adminFee(ctx: Context, args: string[]): Promise<void> {
  if (args.length < 3) {
    await ctx.replyWithMarkdownV2(
      `💸 Comisión actual: *${commissionEngine.getCommissionRate()}%*\n\nUso: \`/admin fee 1\\.8\` \\(entre 1\\.5 y 2\\.5\\)`,
    );
    return;
  }

  const newRate = parseFloat(args[2]);

  if (isNaN(newRate)) {
    await ctx.reply('⚠️ El valor debe ser un número \\(ej: 1\\.8\\)\\.');
    return;
  }

  try {
    commissionEngine.setCommissionRate(newRate);
    await ctx.replyWithMarkdownV2(`✅ Comisión actualizada a *${newRate}%*`);
    logger.info('Admin changed commission rate', { newRate });
  } catch (error) {
    await ctx.replyWithMarkdownV2(
      `⚠️ ${error instanceof Error ? error.message : 'Error al cambiar comisión'}`,
    );
  }
}

// --- /admin raffle ---
async function adminRaffle(ctx: Context): Promise<void> {
  try {
    const status = await raffleEngine.getRaffleStatus();

    if (!status) {
      await ctx.reply('⚠️ No hay sorteo activo\\.');
      return;
    }

    const lines = [
      `🎁 *Admin: Estado del Sorteo*`,
      '',
      `Semana: ${status.weekNumber}`,
      `Premio: ${status.prizePool.toLocaleString()} sats`,
      `Volumen: ${status.totalVolume.toLocaleString()} sats`,
      `Participantes: ${status.participants}`,
      `Pagado: ${status.paid ? '✅ Sí' : '⏳ No'}`,
      '',
    ];

    if (status.lastWinner) {
      lines.push(`Último ganador: @${status.lastWinner}`);
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🎯 Forzar sorteo', 'admin_force_raffle')],
    ]);

    await ctx.replyWithMarkdownV2(lines.join('\n'), keyboard);
  } catch (error) {
    logger.error('Admin raffle error', { error });
    await ctx.reply('⚠️ Error\\.');
  }
}

// --- /admin broadcast <message> ---
async function adminBroadcast(ctx: Context, args: string[]): Promise<void> {
  if (args.length < 3) {
    await ctx.reply('⚠️ Uso: `/admin broadcast Mensaje a enviar a todos los usuarios`');
    return;
  }

  const message = args.slice(2).join(' ');

  try {
    const users = await User.find({}).select('telegramId');
    let sentCount = 0;
    let failCount = 0;

    await ctx.reply(`📢 Enviando broadcast a ${users.length} usuarios...`);

    for (const user of users) {
      try {
        await ctx.telegram.sendMessage(Number(user.telegramId), `📢 *Anuncio SwapBot*\n\n${message}`, { parse_mode: 'MarkdownV2' });
        sentCount++;
      } catch {
        failCount++;
      }
      // Rate limit: 30 msg/sec max
      await new Promise((r) => setTimeout(r, 50));
    }

    await ctx.replyWithMarkdownV2(
      `📢 *Broadcast completado*\n\n✅ Enviados: ${sentCount}\n❌ Fallidos: ${failCount}`,
    );
    logger.info('Admin broadcast', { sentCount, failCount, message });
  } catch (error) {
    logger.error('Admin broadcast error', { error });
    await ctx.reply('⚠️ Error al enviar broadcast\\.');
  }
}

// --- /admin command dispatcher ---
export async function adminCommand(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await unauthorized(ctx);
    return;
  }

  const msg = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = msg.split(/\s+/);
  const subcommand = parts[1] || 'help';

  switch (subcommand) {
    case 'volume':
      await adminVolume(ctx);
      break;
    case 'swaps':
    case 'orders':
      await adminSwaps(ctx);
      break;
    case 'users':
      await adminUsers(ctx);
      break;
    case 'fee':
      await adminFee(ctx, parts);
      break;
    case 'raffle':
      await adminRaffle(ctx);
      break;
    case 'broadcast':
      await adminBroadcast(ctx, parts);
      break;
    case 'help':
    default:
      await ctx.replyWithMarkdownV2(
        `🤖 *Admin Panel*\n\n` +
        `/admin volume — Estadísticas de volumen\n` +
        `/admin swaps — Últimos 20 swaps\n` +
        `/admin users — Usuarios activos\n` +
        `/admin fee <rate> — Cambiar comisión \\(1\\.5\\-2\\.5\\)\n` +
        `/admin raffle — Estado del sorteo\n` +
        `/admin broadcast <msg> — Enviar a todos`,
      );
  }
}

// --- Admin callback handlers ---
export async function handleAdminForceRaffle(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;

  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('⛔ No autorizado');
    return;
  }

  await ctx.answerCbQuery('Ejecutando sorteo...');

  try {
    const result = await forceRaffleDraw();
    if (result) {
      await ctx.editMessageText(
        `🎯 *Sorteo ejecutado\\!*\n\n` +
        `Semana: ${result.weekNumber}\n` +
        `Ganador: @${result.winnerUsername}\n` +
        `Premio: ${result.prizePool.toLocaleString()} sats\n` +
        `Tickets: ${result.winnerTickets}\n` +
        `Participantes: ${result.participants}`,
        { parse_mode: 'MarkdownV2' },
      );
      logger.info('Admin executed raffle draw', { winner: result.winnerUsername });
    } else {
      await ctx.editMessageText('⚠️ El sorteo ya fue ejecutado o no hay participantes\\.');
    }
  } catch (error) {
    logger.error('Admin force raffle error', { error });
    await ctx.editMessageText('⚠️ Error al ejecutar sorteo\\.');
  }
}
