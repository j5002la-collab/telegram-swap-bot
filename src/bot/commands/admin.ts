import { Context, Markup } from 'telegraf';
import { config } from '../../utils/config';
import { logger } from '../../utils/logger';
import { commissionEngine } from '../../engine/commission';
import { raffleEngine } from '../../engine/raffle';
import { forceRaffleDraw } from '../../jobs/raffle-draw';
import { treasuryEngine } from '../../engine/treasury';
import { boltzClient } from '../../boltz/client';
import { Swap, User } from '../../models';

function isAdmin(ctx: Context): boolean {
  return config.adminIds.includes(Number(ctx.from?.id));
}

async function unauthorized(ctx: Context): Promise<void> {
  await ctx.reply('No tienes permisos de administrador.');
}

// --- /admin volume ---
async function adminVolume(ctx: Context): Promise<void> {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todaySwaps = await Swap.countDocuments({ createdAt: { $gte: todayStart }, status: 'completed' });
    const todayVolume = await Swap.aggregate([
      { $match: { createdAt: { $gte: todayStart }, status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$sourceAmount' }, profit: { $sum: '$botProfit' } } },
    ]);
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    const weekSwaps = await Swap.countDocuments({ createdAt: { $gte: weekStart }, status: 'completed' });
    const weekVolume = await Swap.aggregate([
      { $match: { createdAt: { $gte: weekStart }, status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$sourceAmount' }, profit: { $sum: '$botProfit' } } },
    ]);
    const allSwaps = await Swap.countDocuments({ status: 'completed' });
    const allVolume = await Swap.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$sourceAmount' }, profit: { $sum: '$botProfit' } } },
    ]);

    const todayProfit = todayVolume[0]?.profit || 0;
    const weekProfit = weekVolume[0]?.profit || 0;
    const allProfit = allVolume[0]?.profit || 0;

    await ctx.reply(
      'Stats\n\n' +
      `Hoy: ${todaySwaps} swaps, profit ${commissionEngine.formatAmount(todayProfit, 'sats')}\n` +
      `Semana: ${weekSwaps} swaps, profit ${commissionEngine.formatAmount(weekProfit, 'sats')}\n` +
      `Total: ${allSwaps} swaps, profit ${commissionEngine.formatAmount(allProfit, 'sats')}\n` +
      `Comision actual: ${commissionEngine.getCommissionRate()}%`,
    );
  } catch (error) {
    logger.error('Admin volume error', { error });
    await ctx.reply('Error.');
  }
}

// --- /admin swaps ---
async function adminSwaps(ctx: Context): Promise<void> {
  try {
    const recentSwaps = await Swap.find().sort({ createdAt: -1 }).limit(20);
    if (recentSwaps.length === 0) {
      await ctx.reply('No hay swaps aun.');
      return;
    }
    const lines = ['Ultimos 20 swaps', ''];
    for (const s of recentSwaps) {
      const emoji = s.status === 'completed' ? '✅' : s.status === 'failed' ? '❌' : '⏳';
      lines.push(`${emoji} ${s.swapId} ${s.direction} profit=${s.botProfit} ${s.createdAt.toISOString().slice(0, 19)}`);
    }
    await ctx.reply(lines.join('\n'));
  } catch (error) {
    logger.error('Admin swaps error', { error });
    await ctx.reply('Error.');
  }
}

// --- /admin users ---
async function adminUsers(ctx: Context): Promise<void> {
  try {
    const totalUsers = await User.countDocuments();
    const active24h = await User.countDocuments({ lastSeen: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
    const active7d = await User.countDocuments({ lastSeen: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } });
    await ctx.reply(`Total: ${totalUsers}\nActivos 24h: ${active24h}\nActivos 7d: ${active7d}`);
  } catch (error) {
    logger.error('Admin users error', { error });
    await ctx.reply('Error.');
  }
}

// --- /admin fee ---
async function adminFee(ctx: Context, args: string[]): Promise<void> {
  if (args.length < 3) {
    await ctx.reply(`Comision actual: ${commissionEngine.getCommissionRate()}%\nUso: /admin fee 1.8 (1.5-2.5)`);
    return;
  }
  const newRate = parseFloat(args[2]);
  if (isNaN(newRate)) {
    await ctx.reply('Debe ser un numero (ej: 1.8).');
    return;
  }
  try {
    commissionEngine.setCommissionRate(newRate);
    await ctx.reply(`Comision actualizada a ${newRate}%`);
    logger.info('Admin changed commission', { newRate });
  } catch (error) {
    await ctx.reply(`Error: ${error instanceof Error ? error.message : 'invalido'}`);
  }
}

// --- /admin raffle ---
async function adminRaffle(ctx: Context): Promise<void> {
  try {
    const status = await raffleEngine.getRaffleStatus();
    if (!status) { await ctx.reply('No hay sorteo.'); return; }
    const lines = [
      `Sorteo semana ${status.weekNumber}`,
      `Premio: ${status.prizePool.toLocaleString()} sats`,
      `Volumen: ${status.totalVolume.toLocaleString()} sats`,
      `Participantes: ${status.participants}`,
      `Pagado: ${status.paid ? 'Si' : 'No'}`,
    ];
    if (status.lastWinner) lines.push(`Ultimo ganador: @${status.lastWinner}`);
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('Forzar sorteo', 'admin_force_raffle')]]);
    await ctx.reply(lines.join('\n'), keyboard);
  } catch (error) {
    logger.error('Admin raffle error', { error });
    await ctx.reply('Error.');
  }
}

// --- /admin treasury ---
async function adminTreasury(ctx: Context): Promise<void> {
  try {
    const balance = await treasuryEngine.getBalance();
    await ctx.reply(treasuryEngine.formatBalance(balance));
  } catch (error) {
    logger.error('Admin treasury error', { error });
    await ctx.reply('Error.');
  }
}

// --- /admin withdraw ---
async function adminWithdraw(ctx: Context, args: string[]): Promise<void> {
  if (args.length < 3) {
    await ctx.reply('Uso: /admin withdraw <sats>. Ejemplo: /admin withdraw 250000');
    return;
  }

  const amount = parseInt(args[2] || '0', 10);
  if (isNaN(amount) || amount <= 0) {
    await ctx.reply('Monto invalido. Debe ser un numero entero en sats.');
    return;
  }

  try {
    await treasuryEngine.recordWithdrawal(amount);
    const b = await treasuryEngine.getBalance();
    await ctx.reply(
      'Retiro registrado: ' + commissionEngine.formatAmount(amount, 'sats') + '\n' +
      'Balance restante: ' + commissionEngine.formatAmount(b.balance, 'sats') + '\n\n' +
      'Wallet Lightning: ' + (b.lightningAddress || b.btcAddress || 'No configurada') + '\n\n' +
      'El monto NO se envía automáticamente.',
    );
    logger.info('Admin withdrawal recorded', { amount });
  } catch (error) {
    await ctx.reply(`Error: ${error instanceof Error ? error.message : 'invalido'}`);
  }
}

// --- /admin broadcast ---
async function adminBroadcast(ctx: Context, args: string[]): Promise<void> {
  if (args.length < 3) {
    await ctx.reply('Uso: /admin broadcast Mensaje a enviar');
    return;
  }
  const message = args.slice(2).join(' ');
  try {
    const users = await User.find({}).select('telegramId');
    let sent = 0, fail = 0;
    await ctx.reply(`Enviando a ${users.length} usuarios...`);
    for (const user of users) {
      try {
        await ctx.telegram.sendMessage(Number(user.telegramId), 'SwapBot: ' + message);
        sent++;
      } catch { fail++; }
      await new Promise((r) => setTimeout(r, 50));
    }
    await ctx.reply(`Broadcast: ${sent} enviados, ${fail} fallidos`);
    logger.info('Admin broadcast', { sent, fail });
  } catch (error) {
    logger.error('Admin broadcast error', { error });
    await ctx.reply('Error.');
  }
}



// --- /admin pro ---
async function adminPro(ctx: Context, args: string[]): Promise<void> {
  const sub = args[2] || 'status';

  switch (sub) {
    case 'on':
    case 'enable':
    case '1':
      boltzClient.enablePro();
      await ctx.reply(
        'Pro Mode ACTIVADO\n\n' +
        'Los swaps usaran el modo pro para mejores tasas.\n' +
        'Cuando la liquidez este desbalanceada,\n' +
        'los fees bajaran a 0% o negativo.\n\n' +
        'Esto aumenta el margen del bot.'
      );
      break;
    case 'off':
    case 'disable':
    case '0':
      boltzClient.disablePro();
      await ctx.reply('Pro Mode DESACTIVADO. Usando API regular.');
      break;
    case 'status':
    default: {
      const enabled = boltzClient.isProEnabled();
      await ctx.reply(
        'Pro Mode: ' + (enabled ? 'ACTIVADO' : 'DESACTIVADO') + '\n\n' +
        '/admin pro on  — Activar\n' +
        '/admin pro off — Desactivar'
      );
    }
  }
}

// --- Dispatch ---
export async function adminCommand(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) { await unauthorized(ctx); return; }

  const msg = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = msg.split(/\s+/);
  const sub = parts[1] || 'help';

  switch (sub) {
    case 'volume': await adminVolume(ctx); break;
    case 'swaps': case 'orders': await adminSwaps(ctx); break;
    case 'users': await adminUsers(ctx); break;
    case 'fee': await adminFee(ctx, parts); break;
    case 'raffle': await adminRaffle(ctx); break;
    case 'treasury': case 'balance': case 'wallet': await adminTreasury(ctx); break;
    case 'withdraw': await adminWithdraw(ctx, parts); break;
    case 'broadcast': await adminBroadcast(ctx, parts); break;
    case 'pro': await adminPro(ctx, parts); break;
    default:
      await ctx.reply(
        'Admin Panel\n\n' +
        '/admin volume — Estadisticas\n' +
        '/admin swaps — Ultimos swaps\n' +
        '/admin users — Usuarios\n' +
        '/admin fee 1.8 — Cambiar comisión (1.5-2.5)\n' +
        '/admin raffle — Sorteo\n' +
        '/admin treasury — Balance ganancias\n' +
        '/admin withdraw <sats> — Marcar retiro\n' +
        '/admin pro on|off|status — Pro Mode\n' +
        '/admin broadcast — Enviar a todos',
      );
  }
}

export async function handleAdminForceRaffle(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  if (!isAdmin(ctx)) { await ctx.answerCbQuery('No autorizado'); return; }
  await ctx.answerCbQuery('Ejecutando...');
  try {
    const result = await forceRaffleDraw();
    if (result) {
      await ctx.editMessageText(
        `Sorteo ejecutado!\nSemana: ${result.weekNumber}\nGanador: @${result.winnerUsername}\nPremio: ${result.prizePool.toLocaleString()} sats\nParticipantes: ${result.participants}`,
      );
    } else {
      await ctx.editMessageText('El sorteo ya fue ejecutado o no hay participantes.');
    }
  } catch (error) {
    logger.error('Admin force raffle error', { error });
    await ctx.editMessageText('Error.');
  }
}
