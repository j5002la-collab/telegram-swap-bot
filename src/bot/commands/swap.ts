import { Context, Markup } from 'telegraf';
import { rateEngine, RateInfo } from '../../engine/rates';
import { commissionEngine, FeeBreakdown } from '../../engine/commission';
import { raffleEngine } from '../../engine/raffle';
import { treasuryEngine } from '../../engine/treasury';
import type { CurrencyType } from '../../models';
import { getUserState } from '../middleware/user';
import { logger } from '../../utils/logger';
import { Swap, SwapDirection } from '../../models';
import crypto from 'crypto';

// --- In-memory state for multi-step swap flow ---
interface SwapSession {
  direction?: SwapDirection;
  sourceAmount?: number;
  rateInfo?: RateInfo;
  fee?: FeeBreakdown;
}

const swapSessions = new Map<string, SwapSession>();

function getSession(ctx: Context): SwapSession | undefined {
  const uid = String(ctx.from?.id);
  return uid ? swapSessions.get(uid) : undefined;
}

function setSession(ctx: Context, session: SwapSession): void {
  const uid = String(ctx.from?.id);
  if (uid) swapSessions.set(uid, session);
}

function clearSession(ctx: Context): void {
  const uid = String(ctx.from?.id);
  if (uid) swapSessions.delete(uid);
}

// --- Direction labels and mapping ---
type DirectionKey = 'usdt2btc' | 'btc2usdt' | 'usdc2btc' | 'btc2usdc';

const DIRECTION_MAP: Record<DirectionKey, {
  direction: SwapDirection;
  label: string;
  sourceCur: string;
  destCur: string;
  emoji: string;
}> = {
  usdt2btc: { direction: 'USDT2BTC', label: 'USDT → BTC (Lightning)', sourceCur: 'USDT', destCur: 'BTC', emoji: '💎' },
  btc2usdt: { direction: 'BTC2USDT', label: 'BTC (Lightning) → USDT', sourceCur: 'BTC', destCur: 'USDT', emoji: '₿' },
  usdc2btc: { direction: 'USDC2BTC', label: 'USDC → BTC (Lightning)', sourceCur: 'USDC', destCur: 'BTC', emoji: '💵' },
  btc2usdc: { direction: 'BTC2USDC', label: 'BTC (Lightning) → USDC', sourceCur: 'BTC', destCur: 'USDC', emoji: '₿' },
};

// --- Step 1: /swap command — select direction ---
export async function swapCommand(ctx: Context): Promise<void> {
  clearSession(ctx);
  setSession(ctx, {});

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💎 USDT → BTC (Lightning)', 'swap_dir_usdt2btc')],
    [Markup.button.callback('₿ BTC (Lightning) → USDT', 'swap_dir_btc2usdt')],
    [Markup.button.callback('💵 USDC → BTC (Lightning)', 'swap_dir_usdc2btc')],
    [Markup.button.callback('₿ BTC (Lightning) → USDC', 'swap_dir_btc2usdc')],
    [Markup.button.callback('❌ Cancelar', 'swap_cancel')],
  ]);

  await ctx.replyWithMarkdownV2(
    '🔄 *¿Qué quieres convertir\\?*\n\nSelecciona la dirección del swap:',
    keyboard,
  );
}

// --- Step 2: Direction selected → ask for amount ---
export async function handleSwapDirection(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  await ctx.answerCbQuery();

  const action = ctx.callbackQuery.data;
  if (action === 'swap_cancel') {
    clearSession(ctx);
    await ctx.editMessageText('❌ Swap cancelado\\.');
    return;
  }

  const dirKey = action.replace('swap_dir_', '') as DirectionKey;
  const dirInfo = DIRECTION_MAP[dirKey];
  if (!dirInfo) return;

  const session = getSession(ctx) || {};
  session.direction = dirInfo.direction;
  setSession(ctx, session);

  const isBtc = dirInfo.sourceCur === 'BTC';
  const minLabel = isBtc ? '25,000 sats' : '25 USDT/USDC';
  const maxLabel = isBtc ? '25,000,000 sats' : '25,000 USDT/USDC';

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancelar', 'swap_cancel')],
  ]);

  await ctx.editMessageText(
    `🔄 *${dirInfo.emoji} ${dirInfo.label}*\n\n` +
    `💬 Ingresa el monto que quieres convertir:\n\n` +
    `Mín: ${minLabel}\n` +
    `Máx: ${maxLabel}\n\n` +
    `Responde directamente con el número \\(solo números, sin comas ni puntos\\)`,
    { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup },
  );
}

// --- Step 3: Amount entered → show fee breakdown ---
export async function handleSwapAmount(ctx: Context): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) return;

  const session = getSession(ctx);
  if (!session?.direction) return;

  const rawAmount = ctx.message.text.trim();
  const parsedAmount = parseInt(rawAmount, 10);

  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    await ctx.replyWithMarkdownV2(
      '⚠️ *Monto inválido\\.*\n\nPor favor ingresa solo números enteros \\(ej: 50000\\)\\.\nLos montos son en la unidad más pequeña \\(sats para BTC, centavos para USDT/USDC\\)\\.',
    );
    return;
  }

  const dirInfo = Object.values(DIRECTION_MAP).find(
    (d) => d.direction === session.direction,
  );
  if (!dirInfo) return;

  // Determine swap type for Boltz
  const isFromBtc = dirInfo.sourceCur === 'BTC';
  const swapType: 'submarine' | 'reverse' = isFromBtc ? 'reverse' : 'submarine';

  // Get rate
  const fromCur =
    dirInfo.sourceCur === 'BTC' ? 'BTC' : dirInfo.sourceCur;
  const toCur =
    dirInfo.destCur === 'BTC' ? 'BTC' : dirInfo.destCur;

  logger.info('Fetching rate for swap', {
    swapType,
    from: fromCur,
    to: toCur,
    amount: parsedAmount,
  });

  try {
    const rateInfo = await rateEngine.getRate(swapType, fromCur, toCur);

    if (!rateInfo) {
      await ctx.replyWithMarkdownV2(
        '⚠️ *No se pudieron obtener las tasas\\.*\n\nEl servicio de Boltz puede estar temporalmente no disponible\\. Intenta de nuevo en unos minutos\\.',
      );
      return;
    }

    // Validate amount against limits
    if (parsedAmount < rateInfo.minAmount) {
      await ctx.replyWithMarkdownV2(
        `⚠️ *Monto muy bajo\\.*\n\nEl monto mínimo es ${rateInfo.minAmount.toLocaleString()} sats/cents\\.`,
      );
      return;
    }

    if (parsedAmount > rateInfo.maxAmount) {
      await ctx.replyWithMarkdownV2(
        `⚠️ *Monto muy alto\\.*\n\nEl monto máximo es ${rateInfo.maxAmount.toLocaleString()} sats/cents\\.`,
      );
      return;
    }

    // Calculate fees
    const fee = commissionEngine.calculateFeeBreakdown(parsedAmount, rateInfo);

    // Save session
    session.sourceAmount = parsedAmount;
    session.rateInfo = rateInfo;
    session.fee = fee;
    setSession(ctx, session);

    // Show breakdown
    const sourceLabel = dirInfo.sourceCur === 'BTC' ? 'sats' : dirInfo.sourceCur;
    const destLabel = dirInfo.destCur === 'BTC' ? 'sats' : dirInfo.destCur;

    const message = commissionEngine.formatBreakdown(fee, sourceLabel, destLabel);

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Confirmar swap', 'swap_confirm'),
        Markup.button.callback('❌ Cancelar', 'swap_cancel'),
      ],
    ]);

    await ctx.replyWithMarkdownV2(message, keyboard);
  } catch (error) {
    logger.error('Rate fetch failed in swap', { error });
    await ctx.replyWithMarkdownV2(
      '❌ *Error al obtener tasas\\.*\n\nIntenta de nuevo en unos minutos\\.',
    );
  }
}

// --- Step 4: Confirm → execute swap ---
export async function handleSwapConfirm(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  await ctx.answerCbQuery();

  const action = ctx.callbackQuery.data;
  if (action === 'swap_cancel') {
    clearSession(ctx);
    await ctx.editMessageText('❌ Swap cancelado\\.');
    return;
  }

  const session = getSession(ctx);
  if (!session?.direction || !session.sourceAmount || !session.fee) {
    await ctx.editMessageText('⚠️ Sesión expirada\\. Usa /swap para empezar de nuevo\\.');
    clearSession(ctx);
    return;
  }

  await ctx.editMessageText('⏳ *Procesando tu swap\\.\\.\\.*\n\nEsto puede tomar 1\\-5 minutos\\.', { parse_mode: 'MarkdownV2' });

  // Generate swap ID
  const swapId = `SWAP-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const userState = getUserState(ctx);
  const dirInfo = Object.values(DIRECTION_MAP).find(
    (d) => d.direction === session.direction,
  );

  logger.info('Executing swap', {
    swapId,
    direction: session.direction,
    amount: session.sourceAmount,
    userId: userState?.userId,
  });

  try {
    // TODO in Phase 4: connect to Boltz orchestrator when ready
    // For Phase 3, we simulate a successful swap for UI testing

    // Save swap to database
    const swap = await Swap.create({
      swapId,
      userId: userState?.userId || 'unknown',
      direction: session.direction,
      sourceAmount: session.sourceAmount,
      destAmount: session.fee.estimatedReceive,
      sourceCurrency: dirInfo?.sourceCur || 'BTC',
      destCurrency: dirInfo?.destCur || 'BTC',
      boltzSwapId: `BOLTZ-${crypto.randomBytes(4).toString('hex')}`,
      boltzStatus: 'completed',
      commissionRate: session.fee.commissionRate,
      commissionAmount: session.fee.commissionAmount,
      botProfit: session.fee.botProfit,
      status: 'completed',
      completedAt: new Date(),
    });

    logger.info('Swap completed', { swapId, dbId: swap._id });

    // Track raffle volume
    const volumeInSats = session.sourceAmount as number;
    raffleEngine.trackSwapVolume(userState?.userId || 'unknown', volumeInSats).catch((err) => {
      logger.error('Raffle tracking failed', { error: err });
    });

    // Track treasury earnings
    const currency: CurrencyType = dirInfo?.sourceCur === 'USDT' ? 'USDT' : dirInfo?.sourceCur === 'USDC' ? 'USDC' : 'BTC';
    treasuryEngine.trackEarnings(currency, session.fee.commissionAmount).catch((err) => {
      logger.error('Treasury tracking failed', { error: err });
    });

    const successMsg =
      `✅ *¡Swap completado\\!*\n\n` +
      `ID: ${swapId}\n` +
      `Dirección: ${dirInfo?.label}\n` +
      `Monto: ${commissionEngine.formatAmount(session.sourceAmount, dirInfo?.sourceCur || 'BTC')}\n` +
      `Comisión SwapBot: ${commissionEngine.formatAmount(session.fee.commissionAmount, dirInfo?.sourceCur || 'BTC')}`;

    await ctx.editMessageText(successMsg, { parse_mode: 'MarkdownV2' });
  } catch (error) {
    logger.error('Swap execution failed', { error, swapId });
    await ctx.editMessageText(
      '❌ *Error en el swap\\.*\n\nIntenta de nuevo con /swap\\. Si el problema persiste, contacta a @admin\\.',
      { parse_mode: 'MarkdownV2' },
    );
  } finally {
    clearSession(ctx);
  }
}
