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
import { getCNClient } from '../../changenow/client';
import type { BoltzSwapStatus } from '../../boltz/types';
import crypto from 'crypto';

// --- Global state ---
let botInstance: Telegraf<Context> | null = null;
let boltzWebSocket: BoltzWebSocket | null = null;

export function setSwapState(state: { bot?: Telegraf<Context>; ws?: BoltzWebSocket }): void {
  if (state.bot) botInstance = state.bot;
  if (state.ws) boltzWebSocket = state.ws;
}

interface SwapSession {
  step: 'currency' | 'network' | 'direction' | 'invoice';
  currency?: 'BTC' | 'USDT' | 'USDC';
  sourceChain?: ChainNetwork;
  destChain?: ChainNetwork;
  direction?: SwapDirection;
  sourceAmount?: number;
  rateInfo?: RateInfo;
  fee?: FeeBreakdown;
  invoice?: string;
  preimage?: Buffer;
}

const sessions = new Map<string, SwapSession>();
function ss(ctx: Context): SwapSession | undefined { return sessions.get(String(ctx.from?.id)); }
function setSs(ctx: Context, s: SwapSession): void { sessions.set(String(ctx.from?.id), s); }
function clearSs(ctx: Context): void { sessions.delete(String(ctx.from?.id)); }

const SWAP_ERROR = 'Error al crear el intercambio. Intenta de nuevo en unos minutos con /swap.';

// ============================================================
// Step 1: Currency
// ============================================================
export async function swapCommand(ctx: Context): Promise<void> {
  clearSs(ctx);
  setSs(ctx, { step: 'currency' });
  const hasCN = getCNClient() !== null;

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [
    [Markup.button.callback('BTC (On-chain <-> Lightning)', 'swap_cur_BTC')],
  ];

  if (hasCN) {
    buttons.push([Markup.button.callback('USDT -> BTC', 'swap_cur_USDT')]);
    buttons.push([Markup.button.callback('USDC -> BTC', 'swap_cur_USDC')]);
  } else {
    buttons.push([Markup.button.callback('USDT -> BTC (sin API key)', 'swap_cur_disabled')]);
    buttons.push([Markup.button.callback('USDC -> BTC (sin API key)', 'swap_cur_disabled')]);
  }

  buttons.push([Markup.button.callback('Cancelar', 'swap_cancel')]);
  await ctx.reply('Selecciona la moneda:', Markup.inlineKeyboard(buttons));
}

export async function handleSwapCurrency(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  await ctx.answerCbQuery();
  const data = ctx.callbackQuery.data;
  if (data === 'swap_cancel') { clearSs(ctx); await ctx.editMessageText('Cancelado.'); return; }
  if (data === 'swap_cur_disabled') { await ctx.answerCbQuery('Se necesita configurar API key'); return; }

  const currency = data.replace('swap_cur_', '') as 'BTC' | 'USDT' | 'USDC';
  const s = ss(ctx) || { step: 'currency' as const };
  s.currency = currency;

  if (currency === 'BTC') {
    s.step = 'direction';
    s.sourceChain = 'BTC';
    setSs(ctx, s);
    await showDirectionMenu(ctx);
  } else {
    s.step = 'network';
    setSs(ctx, s);
    await showNetworkMenu(ctx, currency);
  }
}

// --- Network menu for USDT/USDC ---
async function showNetworkMenu(ctx: Context, currency: string): Promise<void> {
  const nets = currency === 'USDT'
    ? [
        { label: 'TRC-20 (Tron)', net: 'TRC-20' as ChainNetwork, fee: '~$0.10' },
        { label: 'ERC-20 (Ethereum)', net: 'ERC-20' as ChainNetwork, fee: '~$2-5' },
        { label: 'BEP-20 (BSC)', net: 'BEP-20' as ChainNetwork, fee: '~$0.05' },
        { label: 'Arbitrum', net: 'ARBITRUM' as ChainNetwork, fee: '~$0.01' },
      ]
    : [
        { label: 'ERC-20 (Ethereum)', net: 'ERC-20' as ChainNetwork, fee: '~$2-5' },
        { label: 'Arbitrum', net: 'ARBITRUM' as ChainNetwork, fee: '~$0.01' },
      ];

  const buttons = nets.map(n => [Markup.button.callback(n.label + ' - ' + n.fee, 'swap_net_' + n.net)]);
  buttons.push([Markup.button.callback('Cancelar', 'swap_cancel')]);
  await ctx.editMessageText(currency + ' -> Selecciona la red:', Markup.inlineKeyboard(buttons));
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
  await ctx.editMessageText('A donde quieres recibir?', Markup.inlineKeyboard([
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

  if (s.currency === 'BTC' && dir === 'ONCHAIN2LN') {
    s.step = 'invoice';
    setSs(ctx, s);
    await ctx.editMessageText(
      'Swap: BTC On-chain -> Lightning\n\nPega tu invoice de Lightning (lnbc...).\nDebe ser valida y no expirar pronto.',
      Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
    );
  } else {
    s.step = 'direction';
    setSs(ctx, s);
    const label = s.currency === 'BTC' ? 'sats' : s.currency || 'sats';
    await ctx.editMessageText(
      'Monto a convertir:\nMin: 25,000 | Max: 25,000,000\n\nResponde con el numero (' + label + ').',
      Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
    );
  }
}

// ============================================================
// Step 3: Invoice (submarine only)
// ============================================================
export async function handleSwapInvoice(ctx: Context): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) return;
  const s = ss(ctx);
  if (!s || s.step !== 'invoice') return;

  const raw = ctx.message.text.trim();
  if (!raw.startsWith('lnbc') && !raw.startsWith('lntb') && !raw.startsWith('lnbcrt')) {
    await ctx.reply('Eso no parece una invoice de Lightning. Debe empezar con lnbc...');
    return;
  }

  s.invoice = raw;
  s.step = 'direction';
  setSs(ctx, s);
  await ctx.reply('Invoice recibida. Ahora ingresa el monto (sats):', Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]));
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
    await ctx.reply('Monto invalido. Solo numeros enteros.');
    return;
  }

  try {
    const fee = commissionEngine.calculateFeeBreakdown(amount, {
      boltzRate: 1, userRate: 0.97, boltzFeePct: 0.5, boltzMinerFee: 302,
      botCommissionPct: commissionEngine.getCommissionRate(), botCommissionAmount: 0,
      minAmount: 25000, maxAmount: 25000000, pairHash: '',
    });

    s.sourceAmount = amount;
    s.fee = fee;
    setSs(ctx, s);

    const isBTC = s.currency === 'BTC';
    const dirLabel = isBTC
      ? (s.direction === 'ONCHAIN2LN' ? 'On-chain -> Lightning' : 'Lightning -> On-chain')
      : (s.currency + ' (' + (s.sourceChain || '?') + ') -> ' + (s.destChain === 'LIGHTNING' ? 'Lightning' : 'BTC'));
    const netInfo = s.sourceChain ? ' - Red: ' + s.sourceChain + ' -> ' + (s.destChain || 'BTC') : '';

    const msg = dirLabel + netInfo + '\n\n' + commissionEngine.formatBreakdown(fee, 'sats', 'sats');

    await ctx.reply(msg, Markup.inlineKeyboard([
      [Markup.button.callback('Confirmar', 'swap_confirm'), Markup.button.callback('Cancelar', 'swap_cancel')],
    ]));
  } catch (error) {
    logger.error('Rate error', { error });
    await ctx.reply(SWAP_ERROR);
  }
}

// ============================================================
// Step 5: Confirm → Execute
// ============================================================
export async function handleSwapConfirm(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  await ctx.answerCbQuery();
  if (ctx.callbackQuery.data === 'swap_cancel') { clearSs(ctx); await ctx.editMessageText('Cancelado.'); return; }

  const s = ss(ctx);
  if (!s?.direction || !s.sourceAmount || !s.fee) {
    await ctx.editMessageText('Sesion expirada. Usa /swap.'); clearSs(ctx); return;
  }

  const chatId = ctx.callbackQuery.message?.chat.id;
  const messageId = ctx.callbackQuery.message?.message_id;
  const swapId = 'SWAP-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const userState = getUserState(ctx);

  await ctx.editMessageText('Creando intercambio...');

  // === BTC ROUTE: Boltz (non-custodial) ===
  if (s.currency === 'BTC') {
    try {
      const isReverse = s.direction === 'LN2ONCHAIN';
      let boltzSwapId: string;

      if (isReverse) {
        const preimage = crypto.randomBytes(32);
        const preimageHash = crypto.createHash('sha256').update(preimage).digest('hex');
        const res = await boltzClient.createReverseSwap({
          from: 'BTC', to: 'BTC', invoiceAmount: s.sourceAmount,
          claimPublicKey: crypto.randomBytes(32).toString('hex'), preimageHash,
        });
        boltzSwapId = res.id;
        await ctx.editMessageText(
          'Intercambio creado (Lightning -> On-chain)\n\n' +
          'ID: ' + boltzSwapId + '\n\n' +
          'Paga esta invoice desde tu wallet Lightning:\n\n' +
          '`' + res.invoice + '`\n\n' +
          'Monto: ' + s.sourceAmount.toLocaleString() + ' sats\n\n' +
          'Al pagar, el intercambio se completa automaticamente. Tiempo estimado: 1-5 min.',
        );
      } else {
        if (!s.invoice) { await ctx.editMessageText('Falta la invoice. Usa /swap.'); clearSs(ctx); return; }
        const res = await boltzClient.createSubmarineSwap({
          from: 'BTC', to: 'BTC', invoice: s.invoice,
          refundPublicKey: crypto.randomBytes(32).toString('hex'),
        });
        boltzSwapId = res.id;
        await ctx.editMessageText(
          'Intercambio creado (On-chain -> Lightning)\n\n' +
          'ID: ' + boltzSwapId + '\n\n' +
          'Envia exactamente ' + res.expectedAmount.toLocaleString() + ' sats a:\n\n' +
          '`' + res.address + '`\n\n' +
          'Al confirmarse, recibiras los sats en Lightning. Tiempo: 10-30 min.',
        );
      }

      // WebSocket monitoring
      if (boltzWebSocket && chatId && messageId) {
        boltzWebSocket.subscribe(boltzSwapId, (_id, status) => {
          updateSwapMessage(chatId, messageId, status, swapId, s, boltzSwapId, userState?.userId).catch(() => {});
        });
      }
      setTimeout(() => boltzWebSocket?.unsubscribe(boltzSwapId!), 30 * 60 * 1000);

    } catch (error) {
      logger.error('Swap creation failed', { error, swapId });
      const errMsg = error instanceof Error ? error.message : '';
      await ctx.editMessageText(
        'No se pudo crear el intercambio.\n\n' +
        (errMsg.includes('invoice') ? 'La invoice no es valida. Asegurate que sea una invoice Lightning real.\n\n' : '') +
        (errMsg.includes('pair') ? 'Este par no esta disponible ahora.\n\n' : '') +
        'Intenta de nuevo con /swap.',
      );
      clearSs(ctx);
    }
    return;
  }

  // === USDT/USDC ROUTE: ChangeNOW (custodial exchange) ===
  const cnClient = getCNClient();
  if (!cnClient) {
    await ctx.editMessageText('Cambios USDT/USDC no configurados.\n\nSe necesita una API key de cambio.');
    clearSs(ctx); return;
  }

  try {
    const ticker = cnClient.getTicker(s.currency as 'USDT' | 'USDC', s.sourceChain || 'TRC-20');
    if (!ticker) {
      await ctx.editMessageText('Red no soportada: ' + (s.sourceChain || '?'));
      clearSs(ctx); return;
    }

    const toCurrency = s.destChain === 'LIGHTNING' ? 'btcln' : 'btc';
    const fromAmount = String(s.sourceAmount / 100); // Convert cents to USDT/USDC

    const estimate = await cnClient.estimate(ticker, toCurrency, fromAmount);

    const exchange = await cnClient.createExchange({
      fromCurrency: ticker, toCurrency,
      fromAmount, toAmount: estimate.estimatedAmount,
      address: userState?.userId || 'btc_address_required',
      flow: 'fixed-rate', rateId: estimate.rateId,
    });

    await ctx.editMessageText(
      'Intercambio creado\n\n' +
      'ID: ' + exchange.id + '\n\n' +
      'Envia ' + fromAmount + ' ' + (s.currency || 'USDT') + ' (' + (s.sourceChain || '') + ') a:\n\n' +
      '`' + exchange.payinAddress + '`\n\n' +
      'Recibiras: ~' + estimate.estimatedAmount + ' ' + toCurrency.toUpperCase() + '\n\n' +
      'Al confirmar el deposito, se envia automaticamente.',
    );

  } catch (error) {
    logger.error('ChangeNOW swap failed', { error, swapId });
    await ctx.editMessageText(
      'No se pudo crear el intercambio.\n\n' +
      'Verifica que:\n' +
      '- La API key de ChangeNOW sea valida\n' +
      '- Haya liquidez en el par ' + (s.currency || '?') + '/' + 'BTC' + '\n' +
      '- El monto este dentro de los limites\n\n' +
      'Intenta de nuevo con /swap.',
    );
    clearSs(ctx);
  }
}

// ============================================================
// Status updates (BTC swaps)
// ============================================================
async function updateSwapMessage(
  chatId: number, messageId: number, status: BoltzSwapStatus,
  swapId: string, session: SwapSession, swapServiceId: string, userId?: string,
): Promise<void> {
  if (!botInstance) return;

  const labels: Record<string, string> = {
    'swap.created': 'Creado. Esperando...',
    'invoice.set': 'Invoice validada.',
    'transaction.mempool': 'Transaccion detectada en la red.',
    'transaction.confirmed': 'Confirmada. Procesando pago...',
    'invoice.pending': 'Pagando invoice...',
    'invoice.paid': 'Invoice pagada. Completando...',
    'transaction.claim.pending': 'Casi listo...',
    'transaction.claimed': 'Completado!',
    'invoice.settled': 'Completado!',
    'invoice.failedToPay': 'Error: no se pudo pagar la invoice. Fondos reembolsados.',
    'swap.expired': 'Expiro. Fondos reembolsados.',
    'transaction.lockupFailed': 'Error en el deposito. Verifica el monto.',
    'transaction.failed': 'Error. Fondos reembolsados.',
    'transaction.refunded': 'Fondos reembolsados.',
  };

  const msg = labels[status] || ('Estado: ' + status);

  try {
    await botInstance.telegram.editMessageText(chatId, messageId, undefined,
      'Swap: ' + swapId + '\nID: ' + swapServiceId + '\n\n' + msg);

    if (status === 'transaction.claimed' || status === 'invoice.settled') {
      await Swap.create({
        swapId, userId: userId || 'unknown',
        direction: session.direction,
        sourceChain: session.sourceChain, destChain: session.destChain,
        sourceAmount: session.sourceAmount, destAmount: session.fee?.estimatedReceive || 0,
        sourceCurrency: 'BTC', destCurrency: 'BTC',
        boltzSwapId: swapServiceId, boltzStatus: status,
        commissionRate: session.fee?.commissionRate || 0,
        commissionAmount: session.fee?.commissionAmount || 0,
        botProfit: session.fee?.botProfit || 0,
        status: 'completed', completedAt: new Date(),
      });
      if (session.fee) {
        raffleEngine.trackSwapVolume(userId || 'unknown', session.sourceAmount!).catch(() => {});
        treasuryEngine.trackEarnings(session.fee.commissionAmount).catch(() => {});
      }
    }
  } catch { /* message deleted */ }
}
