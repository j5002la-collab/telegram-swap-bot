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

// --- Global state ---
let botInstance: Telegraf<Context> | null = null;
let boltzWebSocket: BoltzWebSocket | null = null;

export function setSwapState(state: { bot?: Telegraf<Context>; ws?: BoltzWebSocket }): void {
  if (state.bot) botInstance = state.bot;
  if (state.ws) boltzWebSocket = state.ws;
}

// --- Session ---
interface SwapSession {
  step: 'currency' | 'network' | 'direction' | 'invoice';
  currency?: 'BTC' | 'USDT' | 'USDC';
  sourceChain?: ChainNetwork;
  destChain?: ChainNetwork;
  direction?: SwapDirection;
  sourceAmount?: number;
  rateInfo?: RateInfo;
  fee?: FeeBreakdown;
  /** Lightning invoice for submarine swaps */
  invoice?: string;
  /** Preimage for reverse swaps (user needs to claim on-chain BTC) */
  preimage?: Buffer;
}

const sessions = new Map<string, SwapSession>();
function ss(ctx: Context): SwapSession | undefined { return sessions.get(String(ctx.from?.id)); }
function setSs(ctx: Context, s: SwapSession): void { sessions.set(String(ctx.from?.id), s); }
function clearSs(ctx: Context): void { sessions.delete(String(ctx.from?.id)); }

// ============================================================
// Step 1: Currency
// ============================================================
export async function swapCommand(ctx: Context): Promise<void> {
  clearSs(ctx);
  setSs(ctx, { step: 'currency' });
  await ctx.reply('Selecciona la moneda:', Markup.inlineKeyboard([
    [Markup.button.callback('BTC (On-chain <-> Lightning)', 'swap_cur_BTC')],
    [Markup.button.callback('USDT -> BTC (Proximamente)', 'swap_cur_disabled')],
    [Markup.button.callback('USDC -> BTC (Proximamente)', 'swap_cur_disabled')],
    [Markup.button.callback('Cancelar', 'swap_cancel')],
  ]));
}

export async function handleSwapCurrency(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  await ctx.answerCbQuery();
  const data = ctx.callbackQuery.data;
  if (data === 'swap_cancel') { clearSs(ctx); await ctx.editMessageText('Cancelado.'); return; }
  if (data === 'swap_cur_disabled') { await ctx.answerCbQuery('Proximamente disponible'); return; }

  const s = ss(ctx) || { step: 'currency' as const };
  s.currency = data.replace('swap_cur_', '') as 'BTC';
  s.step = 'direction';
  s.sourceChain = 'BTC';
  setSs(ctx, s);
  await showDirectionMenu(ctx);
}

export async function handleSwapNetwork(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  await ctx.answerCbQuery();
  const data = ctx.callbackQuery.data;
  if (data === 'swap_cancel') { clearSs(ctx); await ctx.editMessageText('Cancelado.'); return; }
  const s = ss(ctx); if (!s) return;
  s.sourceChain = data.replace('swap_net_', '') as ChainNetwork;
  s.step = 'direction';
  setSs(ctx, s);
  await showDirectionMenu(ctx);
}

// ============================================================
// Step 2: Direction
// ============================================================
async function showDirectionMenu(ctx: Context): Promise<void> {
  await ctx.editMessageText('BTC -> A donde recibir?', Markup.inlineKeyboard([
    [Markup.button.callback('Lightning (rapido)', 'swap_dir_ONCHAIN2LN')],
    [Markup.button.callback('BTC On-chain', 'swap_dir_LN2ONCHAIN')],
    [Markup.button.callback('Cancelar', 'swap_cancel')],
  ]));
}

export async function handleSwapDirection(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  await ctx.answerCbQuery();
  const data = ctx.callbackQuery.data;
  if (data === 'swap_cancel') { clearSs(ctx); await ctx.editMessageText('Cancelado.'); return; }

  const dir = data.replace('swap_dir_', '') as SwapDirection;
  const s = ss(ctx); if (!s) return;
  s.direction = dir;
  s.destChain = dir === 'LN2ONCHAIN' ? 'BTC' : 'LIGHTNING';

  if (dir === 'ONCHAIN2LN') {
    // Submarine: needs Lightning invoice
    s.step = 'invoice';
    setSs(ctx, s);
    await ctx.editMessageText(
      'Swap: BTC On-chain -> Lightning\n\n' +
      'Necesito tu invoice de Lightning.\n' +
      'Pega la invoice (lnbc...) a la que quieres recibir los sats.\n\n' +
      'La invoice debe ser por el monto que quieres convertir.\n' +
      'Asegurate que no expire pronto (min 2 horas).',
      Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
    );
  } else {
    // Reverse: just need amount
    s.step = 'direction';
    setSs(ctx, s);
    await ctx.editMessageText(
      'Swap: Lightning -> BTC On-chain\n\n' +
      'Monto a convertir (sats):\nMin: 25,000 | Max: 25,000,000\n\n' +
      'Responde con el numero en sats.',
      Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
    );
  }
}

// ============================================================
// Step 3 (submarine): Invoice input
// ============================================================
export async function handleSwapInvoice(ctx: Context): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) return;
  const s = ss(ctx);
  if (!s || s.step !== 'invoice') return;

  const raw = ctx.message.text.trim();
  // Validate LN invoice format
  if (!raw.startsWith('lnbc') && !raw.startsWith('lntb') && !raw.startsWith('lnbcrt')) {
    await ctx.reply('Eso no parece una invoice de Lightning. Debe empezar con lnbc...');
    return;
  }

  s.invoice = raw;
  s.step = 'direction'; // now ask for amount
  setSs(ctx, s);

  await ctx.reply(
    'Invoice recibida. Ahora ingresa el monto a convertir (sats):\n\n' +
    'Min: 25,000 | Max: 25,000,000',
    Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
  );
}

// ============================================================
// Step 4: Amount → fee breakdown
// ============================================================
export async function handleSwapAmount(ctx: Context): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) return;
  const s = ss(ctx);
  if (!s?.direction) return;

  const raw = ctx.message.text.trim();
  const amount = parseInt(raw, 10);
  if (isNaN(amount) || amount <= 0) {
    await ctx.reply('Monto invalido. Solo numeros enteros (sats).');
    return;
  }

  const isReverse = s.direction === 'LN2ONCHAIN';
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
    s.sourceAmount = amount;
    s.rateInfo = rateInfo;
    s.fee = fee;
    setSs(ctx, s);

    const dirLabel = isReverse ? 'Lightning -> BTC On-chain' : 'BTC On-chain -> Lightning';
    const msg = dirLabel + '\n\n' + commissionEngine.formatBreakdown(fee, 'sats', 'sats');

    await ctx.reply(msg, Markup.inlineKeyboard([
      [Markup.button.callback('Confirmar swap', 'swap_confirm'), Markup.button.callback('Cancelar', 'swap_cancel')],
    ]));
  } catch (error) {
    logger.error('Rate error', { error });
    await ctx.reply('Error al conectar con Boltz.');
  }
}

// ============================================================
// Step 5: Confirm → REAL Boltz swap (aligned with docs)
// ============================================================
export async function handleSwapConfirm(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  await ctx.answerCbQuery();
  if (ctx.callbackQuery.data === 'swap_cancel') { clearSs(ctx); await ctx.editMessageText('Cancelado.'); return; }

  const s = ss(ctx);
  if (!s?.direction || !s.sourceAmount || !s.fee) {
    await ctx.editMessageText('Sesion expirada. Usa /swap.');
    clearSs(ctx); return;
  }

  const chatId = ctx.callbackQuery.message?.chat.id;
  const messageId = ctx.callbackQuery.message?.message_id;
  const isReverse = s.direction === 'LN2ONCHAIN';
  const swapId = 'SWAP-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const userState = getUserState(ctx);

  await ctx.editMessageText('Conectando con Boltz...');

  try {
    let boltzSwapId: string;

    if (isReverse) {
      // --- REVERSE SWAP: Lightning → On-chain (docs: client generates preimage) ---
      const preimage = crypto.randomBytes(32);
      s.preimage = preimage;
      setSs(ctx, s);

      const claimKey = crypto.randomBytes(32).toString('hex');
      const res = await boltzClient.createReverseSwap({
        from: 'BTC', to: 'BTC',
        invoiceAmount: s.sourceAmount,
        claimPublicKey: claimKey,
        preimageHash: crypto.createHash('sha256').update(preimage).digest('hex'),
      });
      boltzSwapId = res.id;

      await ctx.editMessageText(
        'Swap creado en Boltz (Lightning -> On-chain)\n\n' +
        'ID: ' + boltzSwapId + '\n\n' +
        'Paga esta invoice desde tu wallet Lightning:\n\n' +
        '`' + res.invoice + '`\n\n' +
        'Monto: ' + s.sourceAmount.toLocaleString() + ' sats\n\n' +
        'Cuando pagues, Boltz lockeara BTC en la chain.\n' +
        'Para reclamar tus BTC usa:\nhttps://boltz.exchange/rescue\n\n(Necesitas la invoice LN que pagaste y el preimage que generamos).',
      );
    } else {
      // --- SUBMARINE SWAP: On-chain → Lightning (docs: user provides invoice FIRST) ---
      if (!s.invoice) {
        await ctx.editMessageText('Falta la invoice de Lightning. Usa /swap de nuevo.');
        clearSs(ctx); return;
      }

      const refundKey = crypto.randomBytes(32).toString('hex');
      const res = await boltzClient.createSubmarineSwap({
        from: 'BTC', to: 'BTC',
        invoice: s.invoice,
        refundPublicKey: refundKey,
      });
      boltzSwapId = res.id;

      await ctx.editMessageText(
        'Swap creado en Boltz (On-chain -> Lightning)\n\n' +
        'ID: ' + boltzSwapId + '\n\n' +
        'Envia EXACTAMENTE ' + res.expectedAmount.toLocaleString() + ' sats a:\n\n' +
        '`' + res.address + '`\n\n' +
        'Una vez confirmada la tx, Boltz pagara tu invoice.\n' +
        'Tiempo estimado: 10-30 minutos.',
      );
    }

    // Subscribe WebSocket
    if (boltzWebSocket && chatId && messageId) {
      boltzWebSocket.subscribe(boltzSwapId, async (_id, status) => {
        await updateSwapMessage(chatId, messageId, status, swapId, s, boltzSwapId, userState?.userId);
      });
    }

    setTimeout(() => { boltzWebSocket?.unsubscribe(boltzSwapId); }, 30 * 60 * 1000);

  } catch (error) {
    logger.error('Boltz swap failed', { error, swapId });
    await ctx.editMessageText(
      'Error al crear swap con Boltz.\n\n' +
      'Posible causa: servicio no disponible o invoice invalida.\n' +
      'Intenta de nuevo con /swap.',
    );
    clearSs(ctx);
  }
}

// ============================================================
// WebSocket → Telegram status updates (aligned with Boltz lifecycle docs)
// ============================================================
async function updateSwapMessage(
  chatId: number, messageId: number,
  status: BoltzSwapStatus,
  swapId: string, session: SwapSession, boltzSwapId: string, userId?: string,
): Promise<void> {
  if (!botInstance) return;

  // All states from Boltz lifecycle docs
  const labels: Record<string, string> = {
    'swap.created': 'Swap creado en Boltz. Esperando...',
    // Submarine states
    'invoice.set': 'Invoice de Lightning validada.',
    'transaction.mempool': 'Transaccion detectada en la red Bitcoin.',
    'transaction.confirmed': 'Transaccion confirmada (1 bloque).',
    'invoice.pending': 'Boltz esta pagando tu invoice Lightning...',
    'invoice.paid': 'Invoice pagada! Boltz reclama los fondos...',
    'transaction.claim.pending': 'Boltz reclamando. Swap casi listo.',
    'transaction.claimed': 'Swap completado!',
    'invoice.failedToPay': 'Error: Boltz no pudo pagar la invoice.\nTus fondos seran reembolsados.\n\nRecupera tus fondos:\nhttps://boltz.exchange/refund/',
    'transaction.lockupFailed': 'Error en el deposito. Monto incorrecto.\n\nRecupera tus fondos:\nhttps://boltz.exchange/refund/',
    // Reverse states
    'minerfee.paid': 'Miner fee pagado.',
    'invoice.settled': 'Swap completado! Recibiras BTC en la chain.',
    'invoice.expired': 'Invoice expiro. Reintenta con /swap.',
    'transaction.failed': 'Error en el swap. Fondos reembolsados automaticamente.',
    'transaction.refunded': 'Fondos reembolsados automaticamente.',
    // Common
    'swap.expired': 'Swap expirado. Si enviaste fondos:\n\nRecuperar: https://boltz.exchange/refund/\nRescate: https://boltz.exchange/rescue',
  };

  const msg = labels[status] || ('Estado Boltz: ' + status);
  const full = 'Swap: ' + swapId + '\nBoltz ID: ' + boltzSwapId + '\n\n' + msg;

  try {
    await botInstance.telegram.editMessageText(chatId, messageId, undefined, full);

    // On success: save
    if (status === 'transaction.claimed' || status === 'invoice.settled') {
      await Swap.create({
        swapId, userId: userId || 'unknown',
        direction: session.direction,
        sourceChain: session.sourceChain, destChain: session.destChain,
        sourceAmount: session.sourceAmount, destAmount: session.fee?.estimatedReceive || 0,
        sourceCurrency: 'BTC', destCurrency: 'BTC',
        boltzSwapId, boltzStatus: status,
        commissionRate: session.fee?.commissionRate || 0,
        commissionAmount: session.fee?.commissionAmount || 0,
        botProfit: session.fee?.botProfit || 0,
        status: 'completed', completedAt: new Date(),
      });
      if (session.fee) {
        raffleEngine.trackSwapVolume(userId || 'unknown', session.sourceAmount!).catch(() => {});
        treasuryEngine.trackEarnings(session.fee.commissionAmount).catch(() => {});
      }
      logger.info('Swap completed', { swapId, boltzSwapId, amount: session.sourceAmount });
    }
  } catch { /* message may be deleted */ }
}
