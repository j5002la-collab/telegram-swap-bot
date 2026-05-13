import { Context, Markup, Telegraf } from 'telegraf';
import { rateEngine, RateInfo } from '../../engine/rates';
import { commissionEngine, FeeBreakdown } from '../../engine/commission';
import { raffleEngine } from '../../engine/raffle';
import { treasuryEngine } from '../../engine/treasury';
import { getUserState } from '../middleware/user';
import { logger } from '../../utils/logger';
import { Swap, SwapDirection, ChainNetwork } from '../../models';
import { boltzClient } from '../../boltz/client';
import { BoltzWebSocket } from '../../boltz/websocket';
import type { BoltzSwapStatus } from '../../boltz/types';
import crypto from 'crypto';

// --- Global state (set by bot.ts at startup) ---
let botInstance: Telegraf<Context> | null = null;
let boltzWebSocket: BoltzWebSocket | null = null;

export function setSwapState(state: { bot?: Telegraf<Context>; ws?: BoltzWebSocket }): void {
  if (state.bot) botInstance = state.bot;
  if (state.ws) boltzWebSocket = state.ws;
}

// --- Session State ---
interface SwapSession {
  step: 'currency' | 'network' | 'direction';
  currency?: 'BTC' | 'USDT' | 'USDC';
  sourceChain?: ChainNetwork;
  destChain?: ChainNetwork;
  direction?: SwapDirection;
  sourceAmount?: number;
  rateInfo?: RateInfo;
  fee?: FeeBreakdown;
}

const sessions = new Map<string, SwapSession>();

function ss(ctx: Context): SwapSession | undefined {
  return sessions.get(String(ctx.from?.id));
}
function setSs(ctx: Context, s: SwapSession): void {
  sessions.set(String(ctx.from?.id), s);
}
function clearSs(ctx: Context): void {
  sessions.delete(String(ctx.from?.id));
}

// ============================================================
// Step 1: Select currency
// ============================================================
export async function swapCommand(ctx: Context): Promise<void> {
  clearSs(ctx);
  setSs(ctx, { step: 'currency' });

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [
    [Markup.button.callback('BTC (On-chain <-> Lightning)', 'swap_cur_BTC')],
    [Markup.button.callback('USDT -> BTC (Proximamente)', 'swap_cur_disabled')],
    [Markup.button.callback('USDC -> BTC (Proximamente)', 'swap_cur_disabled')],
    [Markup.button.callback('Cancelar', 'swap_cancel')],
  ];

  await ctx.reply('Selecciona la moneda:', Markup.inlineKeyboard(buttons));
}

// ============================================================
// Step 1 handler: Currency selected
// ============================================================
export async function handleSwapCurrency(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  await ctx.answerCbQuery();

  const data = ctx.callbackQuery.data;

  if (data === 'swap_cancel') { clearSs(ctx); await ctx.editMessageText('Cancelado.'); return; }
  if (data === 'swap_cur_disabled') { await ctx.answerCbQuery('Proximamente disponible'); return; }

  const currency = data.replace('swap_cur_', '') as 'BTC' | 'USDT' | 'USDC';
  const session = ss(ctx) || { step: 'currency' as const };
  session.currency = currency;

  session.step = 'direction';
  session.sourceChain = 'BTC';
  setSs(ctx, session);
  await showDirectionMenu(ctx);
}

// ============================================================
// Step 2 (USDT/USDC): Network selection
// ============================================================
export async function handleSwapNetwork(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  await ctx.answerCbQuery();

  const data = ctx.callbackQuery.data;
  if (data === 'swap_cancel') { clearSs(ctx); await ctx.editMessageText('Cancelado.'); return; }

  const net = data.replace('swap_net_', '') as ChainNetwork;
  const session = ss(ctx);
  if (!session) return;

  session.sourceChain = net;
  session.step = 'direction';
  setSs(ctx, session);
  await showDirectionMenu(ctx);
}

// ============================================================
// Step 3: Direction (Lightning vs On-chain)
// ============================================================
async function showDirectionMenu(ctx: Context): Promise<void> {
  await ctx.editMessageText(
    'BTC -> A donde quieres recibir?',
    Markup.inlineKeyboard([
      [Markup.button.callback('A Lightning (rapido, bajo fee)', 'swap_dir_LN2ONCHAIN')],
      [Markup.button.callback('A BTC On-chain', 'swap_dir_ONCHAIN2LN')],
      [Markup.button.callback('Cancelar', 'swap_cancel')],
    ]),
  );
}

export async function handleSwapDirection(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  await ctx.answerCbQuery();

  const data = ctx.callbackQuery.data;
  if (data === 'swap_cancel') { clearSs(ctx); await ctx.editMessageText('Cancelado.'); return; }

  const dir = data.replace('swap_dir_', '') as SwapDirection;
  const session = ss(ctx);
  if (!session) return;

  session.direction = dir;
  session.destChain = dir === 'ONCHAIN2LN' ? 'LIGHTNING' : 'BTC';
  setSs(ctx, session);

  const minLabel = '25,000 sats';
  const maxLabel = '25,000,000 sats';

  await ctx.editMessageText(
    'Monto a convertir (BTC):\n\n' +
    'Min: ' + minLabel + '\nMax: ' + maxLabel + '\n\n' +
    'Responde con el numero en sats (sin comas ni puntos)',
    Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
  );
}

// ============================================================
// Step 4: Amount → fee breakdown
// ============================================================
export async function handleSwapAmount(ctx: Context): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) return;
  const session = ss(ctx);
  if (!session?.direction) return;

  const raw = ctx.message.text.trim();
  const amount = parseInt(raw, 10);
  if (isNaN(amount) || amount <= 0) {
    await ctx.reply('Monto invalido. Solo numeros enteros (sats).');
    return;
  }

  const isReverse = session.direction === 'LN2ONCHAIN';
  const swapType = isReverse ? 'reverse' as const : 'submarine' as const;

  try {
    const rateInfo = await rateEngine.getRate(swapType, 'BTC', 'BTC');
    if (!rateInfo) {
      await ctx.reply('No se pudo conectar con Boltz. Intenta mas tarde.');
      return;
    }

    if (amount < rateInfo.minAmount) {
      await ctx.reply('Monto muy bajo. Minimo: ' + rateInfo.minAmount.toLocaleString() + ' sats.');
      return;
    }
    if (amount > rateInfo.maxAmount) {
      await ctx.reply('Monto muy alto. Maximo: ' + rateInfo.maxAmount.toLocaleString() + ' sats.');
      return;
    }

    const fee = commissionEngine.calculateFeeBreakdown(amount, rateInfo);
    session.sourceAmount = amount;
    session.rateInfo = rateInfo;
    session.fee = fee;
    setSs(ctx, session);

    const msg = commissionEngine.formatBreakdown(fee, 'sats', 'sats');

    await ctx.reply(msg, Markup.inlineKeyboard([
      [Markup.button.callback('Confirmar swap', 'swap_confirm'), Markup.button.callback('Cancelar', 'swap_cancel')],
    ]));
  } catch (error) {
    logger.error('Rate fetch failed', { error });
    await ctx.reply('Error al obtener tasas. Intenta de nuevo.');
  }
}

// ============================================================
// Step 5: Confirm → REAL Boltz swap
// ============================================================
export async function handleSwapConfirm(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  await ctx.answerCbQuery();

  if (ctx.callbackQuery.data === 'swap_cancel') {
    clearSs(ctx);
    await ctx.editMessageText('Cancelado.');
    return;
  }

  const session = ss(ctx);
  if (!session?.direction || !session.sourceAmount || !session.fee) {
    await ctx.editMessageText('Sesion expirada. Usa /swap de nuevo.');
    clearSs(ctx);
    return;
  }

  const chatId = ctx.callbackQuery.message?.chat.id;
  const messageId = ctx.callbackQuery.message?.message_id;

  await ctx.editMessageText('Conectando con Boltz...');

  const swapId = 'SWAP-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const userState = getUserState(ctx);
  const isReverse = session.direction === 'LN2ONCHAIN';

  logger.info('Executing real swap', { swapId, direction: session.direction, amount: session.sourceAmount, isReverse });

  try {
    let boltzSwapId: string;
    let payTo: string;

    if (isReverse) {
      // Reverse: Lightning → On-chain
      const preimage = crypto.randomBytes(32);
      const preimageHash = crypto.createHash('sha256').update(preimage).digest('hex');
      const claimKey = crypto.randomBytes(32).toString('hex');

      const response = await boltzClient.createReverseSwap({
        from: 'BTC',
        to: 'BTC',
        invoiceAmount: session.sourceAmount,
        claimPublicKey: claimKey,
        preimageHash,
      });

      boltzSwapId = response.id;
      payTo = response.invoice;
      await ctx.editMessageText(
        'Swap creado en Boltz\n\n' +
        'ID: ' + boltzSwapId + '\n\n' +
        'Paga esta invoice desde tu wallet Lightning:\n\n' +
        '`' + response.invoice + '`\n\n' +
        'Monto: ' + session.sourceAmount.toLocaleString() + ' sats\n\n' +
        'Una vez pagada, el bot detectara el pago automaticamente.\nTiempo estimado: 1-5 minutos.',
      );
    } else {
      // Submarine: On-chain → Lightning
      const refundKey = crypto.randomBytes(32).toString('hex');

      const response = await boltzClient.createSubmarineSwap({
        from: 'BTC',
        to: 'BTC',
        invoice: '', // User hasn't provided invoice yet
        refundPublicKey: refundKey,
      });

      boltzSwapId = response.id;
      payTo = response.address;
      await ctx.editMessageText(
        'Swap creado en Boltz\n\n' +
        'ID: ' + boltzSwapId + '\n\n' +
        'Envia ' + response.expectedAmount.toLocaleString() + ' sats a:\n\n' +
        '`' + response.address + '`\n\n' +
        'Una vez detectada la transaccion, Boltz pagara tu invoice.\nTiempo estimado: 10-30 minutos.',
      );
    }

    // Subscribe to WebSocket for live status
    if (boltzWebSocket && chatId && messageId) {
      boltzWebSocket.subscribe(boltzSwapId, async (_id, status) => {
        await updateSwapMessage(chatId, messageId, status, swapId, session, boltzSwapId, userState?.userId);
      });
    }

    // Timeout safety net
    setTimeout(async () => {
      boltzWebSocket?.unsubscribe(boltzSwapId);
    }, 30 * 60 * 1000);

  } catch (error) {
    logger.error('Boltz swap creation failed', { error, swapId });
    await ctx.editMessageText(
      'Error al crear el swap con Boltz.\n\n' +
      'Posible causa: servicio temporalmente no disponible.\nIntenta de nuevo con /swap en unos minutos.',
    );
    clearSs(ctx);
  }
}

// ============================================================
// Live status updates via WebSocket
// ============================================================
async function updateSwapMessage(
  chatId: number,
  messageId: number,
  status: BoltzSwapStatus,
  swapId: string,
  session: SwapSession,
  boltzSwapId: string,
  userId?: string,
): Promise<void> {
  if (!botInstance) return;

  const statusMessages: Record<string, string> = {
    'swap.created': 'Swap creado en Boltz. Esperando...',
    'invoice.set': 'Invoice validada. Esperando pago on-chain...',
    'transaction.mempool': 'Transaccion detectada en la red. Esperando confirmacion...',
    'transaction.confirmed': 'Transaccion confirmada. Boltz esta procesando el pago...',
    'invoice.pending': 'Pagando invoice Lightning...',
    'invoice.paid': 'Invoice pagada. Boltz esta reclamando los fondos...',
    'transaction.claim.pending': 'Swap casi completo. Boltz reclamando...',
    'transaction.claimed': 'Swap completado exitosamente!',
    'invoice.settled': 'Swap completado exitosamente!',
    'invoice.failedToPay': 'Error: Boltz no pudo pagar la invoice. Tus fondos seran reembolsados.',
    'swap.expired': 'Swap expirado. Si enviaste fondos, seran reembolsados automaticamente.',
    'transaction.lockupFailed': 'Error en el deposito. Verifica el monto enviado.',
    'transaction.failed': 'Error en el swap. Contacta a soporte.',
    'transaction.refunded': 'Fondos reembolsados.',
  };

  const msg = statusMessages[status] || ('Estado: ' + status);

  try {
    await botInstance.telegram.editMessageText(
      chatId, messageId, undefined,
      'Swap: ' + swapId + '\nBoltz: ' + boltzSwapId + '\n\n' + msg,
    );

    // On success: save to DB
    if (status === 'transaction.claimed' || status === 'invoice.settled') {
      const userState = userId ? { userId } : undefined;
      await Swap.create({
        swapId,
        userId: userId || 'unknown',
        direction: session.direction,
        sourceChain: session.sourceChain,
        destChain: session.destChain,
        sourceAmount: session.sourceAmount,
        destAmount: session.fee?.estimatedReceive || 0,
        sourceCurrency: 'BTC',
        destCurrency: 'BTC',
        boltzSwapId,
        boltzStatus: status,
        commissionRate: session.fee?.commissionRate || 0,
        commissionAmount: session.fee?.commissionAmount || 0,
        botProfit: session.fee?.botProfit || 0,
        status: 'completed',
        completedAt: new Date(),
      });

      if (session.fee) {
        raffleEngine.trackSwapVolume(userId || 'unknown', session.sourceAmount!).catch(() => {});
        treasuryEngine.trackEarnings(session.fee.commissionAmount).catch(() => {});
      }

      logger.info('Real swap completed and saved', { swapId, boltzSwapId, amount: session.sourceAmount });
    }
  } catch {
    // Message might have been deleted by user
  }
}
