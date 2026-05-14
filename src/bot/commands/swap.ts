import { Context, Markup, Telegraf } from 'telegraf';
import { rateEngine, RateInfo } from '../../engine/rates';
import { commissionEngine, FeeBreakdown } from '../../engine/commission';
import { raffleEngine } from '../../engine/raffle';
import { treasuryEngine } from '../../engine/treasury';
import { getUserState } from '../middleware/user';
import { logger } from '../../utils/logger';
import { Swap, SwapDirection, ChainNetwork, User } from '../../models';
import { boltzClient } from '../../boltz/client';
import { BoltzWebSocket } from '../../boltz/websocket';
import { getCNClient } from '../../changenow/client';
import type { BoltzSwapStatus } from '../../boltz/types';
import bolt11 from 'bolt11';
import crypto from 'crypto';

// --- Global state ---
let botInstance: Telegraf<Context> | null = null;
let boltzWebSocket: BoltzWebSocket | null = null;

export function setSwapState(state: { bot?: Telegraf<Context>; ws?: BoltzWebSocket }): void {
  if (state.bot) botInstance = state.bot;
  if (state.ws) boltzWebSocket = state.ws;
}

interface SwapSession {
  step: 'currency' | 'network' | 'direction' | 'invoice' | 'amount' | 'address' | 'confirm';
  currency?: 'BTC' | 'USDT' | 'USDC';
  sourceChain?: ChainNetwork;
  destChain?: ChainNetwork;
  direction?: SwapDirection;
  sourceAmount?: number;
  rateInfo?: RateInfo;
  fee?: FeeBreakdown;
  invoice?: string;
  destAddress?: string;
  preimage?: Buffer;
}

const sessions = new Map<string, SwapSession>();
function ss(ctx: Context): SwapSession | undefined { return sessions.get(String(ctx.from?.id)); }
function setSs(ctx: Context, s: SwapSession): void { sessions.set(String(ctx.from?.id), s); }
function clearSs(ctx: Context): void { sessions.delete(String(ctx.from?.id)); }

const SWAP_ERROR = 'Error al crear el intercambio. Intenta de nuevo en unos minutos con /swap.';

/** Decode amount in sats from a BOLT11 Lightning invoice. Returns null if no amount. */
function decodeInvoiceAmount(invoice: string): number | null {
  try {
    const decoded = bolt11.decode(invoice);
    // Amount is in millisatoshis, convert to sats
    if (decoded.millisatoshis) {
      return Math.floor(Number(decoded.millisatoshis) / 1000);
    }
    // Some invoices have amount in the HRP prefix (lnbc300u = 30000 sats)
    if (decoded.satoshis) {
      return Number(decoded.satoshis);
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================

// ============================================================
// Cancel — force clear session
// ============================================================
export async function cancelCommand(ctx: Context): Promise<void> {
  clearSs(ctx);
  await ctx.reply('Sesión cancelada. Usa /swap para empezar de nuevo.');
}

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

async function showNetworkMenu(ctx: Context, currency: string): Promise<void> {
  const allNets = currency === 'USDT'
    ? [
        { label: 'TRC-20 (Tron)', net: 'TRC-20' as ChainNetwork, fee: '~$0.10' },
        { label: 'BEP-20 (BSC)', net: 'BEP-20' as ChainNetwork, fee: '~$0.05' },
        { label: 'Solana', net: 'SOLANA' as ChainNetwork, fee: '~$0.01' },
        { label: 'Polygon', net: 'POLYGON' as ChainNetwork, fee: '~$0.02' },
        { label: 'Arbitrum', net: 'ARBITRUM' as ChainNetwork, fee: '~$0.01' },
        { label: 'ERC-20 (Ethereum)', net: 'ERC-20' as ChainNetwork, fee: '~$2-5' },
        { label: 'Optimism', net: 'OPTIMISM' as ChainNetwork, fee: '~$0.02' },
        { label: 'Avalanche', net: 'AVALANCHE' as ChainNetwork, fee: '~$0.03' },
        { label: 'Base', net: 'BASE' as ChainNetwork, fee: '~$0.01' },
      ]
    : [
        { label: 'Solana', net: 'SOLANA' as ChainNetwork, fee: '~$0.01' },
        { label: 'Arbitrum', net: 'ARBITRUM' as ChainNetwork, fee: '~$0.01' },
        { label: 'Base', net: 'BASE' as ChainNetwork, fee: '~$0.01' },
        { label: 'Polygon', net: 'POLYGON' as ChainNetwork, fee: '~$0.02' },
        { label: 'ERC-20 (Ethereum)', net: 'ERC-20' as ChainNetwork, fee: '~$2-5' },
        { label: 'Optimism', net: 'OPTIMISM' as ChainNetwork, fee: '~$0.02' },
        { label: 'Avalanche', net: 'AVALANCHE' as ChainNetwork, fee: '~$0.03' },
      ];

  const buttons = allNets.map(n => [Markup.button.callback(n.label + ' - ' + n.fee, 'swap_net_' + n.net)]);
  buttons.push([Markup.button.callback('Cancelar', 'swap_cancel')]);
  await ctx.editMessageText(currency + ' -> Selecciona la red con menor fee:', Markup.inlineKeyboard(buttons));
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
  const s = ss(ctx);
  const isBTC = !s || s.currency === 'BTC';

  if (isBTC) {
    await ctx.editMessageText('Que tipo de intercambio quieres hacer?', Markup.inlineKeyboard([
      [Markup.button.callback('Enviar BTC On-chain -> Recibir en Lightning', 'swap_dir_ONCHAIN2LN')],
      [Markup.button.callback('Enviar por Lightning -> Recibir BTC On-chain', 'swap_dir_LN2ONCHAIN')],
      [Markup.button.callback('Cancelar', 'swap_cancel')],
    ]));
  } else {
    const cur = s.currency || 'USDT';
    await ctx.editMessageText(cur + ' -> Selecciona destino:', Markup.inlineKeyboard([
      [Markup.button.callback('Recibir en Lightning', 'swap_dir_ONCHAIN2LN')],
      [Markup.button.callback('Recibir en BTC On-chain', 'swap_dir_LN2ONCHAIN')],
      [Markup.button.callback('Cancelar', 'swap_cancel')],
    ]));
  }
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
      'BTC On-chain -> Lightning\n\nPega tu invoice de Lightning (lnbc...).\nEl monto se detectará automáticamente.',
      Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
    );
  } else if (s.currency !== 'BTC') {
    s.step = 'address';
    setSs(ctx, s);
    const destType = s.destChain === 'LIGHTNING' ? 'Lightning (invoice lnbc...)' : 'BTC On-chain (bc1...)';
    await ctx.editMessageText(
       'Dirección ' + destType + ':\n\nPega la dirección donde recibirás los fondos.',
      Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
    );
  } else {
    s.step = 'amount';
    setSs(ctx, s);
    await ctx.editMessageText(
      'Ingresa el monto en sats:\nMin: 25,000 | Max: 25,000,000',
      Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
    );
  }
}

// ============================================================
// Step 3: Invoice (submarine) → auto-detect amount
// ============================================================
export async function handleSwapInvoice(ctx: Context): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) return;
  const s = ss(ctx);
  if (!s || s.step !== 'invoice') return; // Only handle when actively waiting for invoice

  const raw = ctx.message.text.trim();

  // Reject testnet/regtest invoices — only mainnet (lnbc) accepted
  if (raw.startsWith('lntb') || raw.startsWith('lnbcrt')) {
    await ctx.reply(
      '⚠️ Factura de testnet/regtest detectada.\n\n' +
      'SwapBot solo opera en Bitcoin mainnet.\n' +
      'Genera una factura mainnet (lnbc...) e inténtalo de nuevo.',
    );
    return;
  }

  if (!raw.startsWith('lnbc')) return;

  // Decode invoice
  const invoiceAmount = decodeInvoiceAmount(raw);

  s.invoice = raw;
  setSs(ctx, s);

  if (invoiceAmount && invoiceAmount > 0) {
    // Auto-detect amount from invoice → skip to fee breakdown
    await processAmount(ctx, invoiceAmount);
  } else {
    // Invoice has no amount → ask user for amount
    s.step = 'amount';
    setSs(ctx, s);
    await ctx.reply(
      'Invoice recibida pero no tiene monto incluido.\n\n' +
      'Ingresa el monto en sats:',
      Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
    );
  }
}

// ============================================================
// Step 4: Address (USDT/USDC) + Amount
// ============================================================
export async function handleSwapAddress(ctx: Context): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) return;
  const s = ss(ctx);
  if (!s || s.step !== 'address') return;

  const raw = ctx.message.text.trim();
  if (!raw || raw.length < 10) {
    await ctx.reply('Dirección muy corta. Pega tu invoice Lightning (lnbc...) o direccion BTC (bc1...).');
    return;
  }

  try {
    s.destAddress = raw;
    s.step = 'amount';
    setSs(ctx, s);
    logger.info('Address saved', { addr: raw.slice(0, 20) + '...' });
  } catch (err) {
    logger.error('Failed to save address', { error: err });
    await ctx.reply('Error al guardar la dirección. Intenta de nuevo.');
    return;
  }

  await ctx.reply(
    'Dirección guardada. Ahora ingresa el monto en USD:\nEjemplo: 100 ($100 USD)\n\nResponde con el numero.',
    Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
  );
}

export async function handleSwapAmount(ctx: Context): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) return;
  const s = ss(ctx);
  if (!s || s.step !== 'amount') return; // Only handle when waiting for amount

  // Skip Lightning invoices (handled by handleSwapInvoice); reject testnet
  const raw = ctx.message.text.trim();
  if (raw.startsWith('ln')) {
    if (raw.startsWith('lntb') || raw.startsWith('lnbcrt')) {
      await ctx.reply('⚠️ Solo se aceptan facturas mainnet (lnbc...).');
      return;
    }
    if (raw.startsWith('lnbc')) return; // handled by handleSwapInvoice
  }

  const amount = parseInt(raw, 10);
  if (isNaN(amount) || amount <= 0) {
    await ctx.reply('Monto invalido. Solo numeros enteros.');
    return;
  }

  await processAmount(ctx, amount);
}

async function processAmount(ctx: Context, amount: number): Promise<void> {
  const s = ss(ctx);
  if (!s) return;

  try {
    // --- Fetch real rates depending on currency ---
    let rateInfo: RateInfo | null = null;
    const isBTC = s.currency === 'BTC';

    if (isBTC) {
      const isReverse = s.direction === 'LN2ONCHAIN';
      rateInfo = await rateEngine.getRate(
        isReverse ? 'reverse' : 'submarine',
        'BTC',
        'BTC',
      );
    } else if (s.currency === 'USDT' || s.currency === 'USDC') {
      // USDT/USDC: attempt ChangeNOW estimate for real rate display
      const cnClient = getCNClient();
      if (cnClient) {
        try {
          const ticker = cnClient.getTicker(s.currency, s.sourceChain || 'TRC-20');
          if (ticker) {
            const toCurrency = s.destChain === 'LIGHTNING' ? 'btcln' : 'btc';
            const fromAmount = String(amount / 100);
            const estimate = await cnClient.estimate(ticker, toCurrency, fromAmount);
            rateInfo = {
              boltzRate: parseFloat(estimate.estimatedAmount) / parseFloat(fromAmount),
              userRate: parseFloat(estimate.estimatedAmount) / parseFloat(fromAmount),
              boltzFeePct: 0.5, // ChangeNOW fixed-rate fee
              boltzMinerFee: 0,
              botCommissionPct: commissionEngine.getCommissionRate(),
              botCommissionAmount: 0,
              minAmount: 1000,  // ~$10 in cents
              maxAmount: 2000000, // ~$20,000 in cents
              pairHash: estimate.rateId,
            };
          }
        } catch {
          logger.warn('ChangeNOW estimate failed for rate display, using defaults');
        }
      }
    }

    // Fallback when rate fetch fails
    if (!rateInfo) {
      rateInfo = {
        boltzRate: 1,
        userRate: 0.97,
        boltzFeePct: 0.5,
        boltzMinerFee: isBTC ? 302 : 0,
        botCommissionPct: commissionEngine.getCommissionRate(),
        botCommissionAmount: 0,
        minAmount: isBTC ? 25000 : 1000,
        maxAmount: isBTC ? 25000000 : 2000000,
        pairHash: '',
      };
    }

    // Validate amount against limits
    if (amount < rateInfo.minAmount) {
      await ctx.reply(`Monto muy bajo. Mínimo ${rateInfo.minAmount.toLocaleString()}.`);
      return;
    }
    if (amount > rateInfo.maxAmount) {
      await ctx.reply(`Monto muy alto. Máximo ${rateInfo.maxAmount.toLocaleString()}.`);
      return;
    }

    s.sourceAmount = amount;
    s.rateInfo = rateInfo;
    s.fee = commissionEngine.calculateFeeBreakdown(amount, rateInfo);
    s.step = 'confirm';
    setSs(ctx, s);

    const sourceLabel = isBTC ? 'sats' : (s.currency || 'USDT');
    const destLabel = isBTC ? 'sats' : 'BTC';
    const msg = commissionEngine.formatBreakdown(s.fee, sourceLabel, destLabel);

    await ctx.reply(msg, Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirmar', 'swap_confirm'), Markup.button.callback('❌ Cancelar', 'swap_cancel')],
    ]));
  } catch (error) {
    logger.error('Process amount error', { error });
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
    await ctx.editMessageText('Sesión expirada. Usa /swap.'); clearSs(ctx); return;
  }

  const chatId = ctx.callbackQuery.message?.chat.id;
  const messageId = ctx.callbackQuery.message?.message_id;
  const swapId = 'SWAP-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const userState = getUserState(ctx);

  await ctx.editMessageText('Creando intercambio...');

  // === BTC ROUTE ===
  if (s.currency === 'BTC') {
    try {
      const isReverse = s.direction === 'LN2ONCHAIN';
      let swapServiceId: string;
      let preimageHex: string | undefined;

      if (isReverse) {
        const preimage = crypto.randomBytes(32);
        preimageHex = preimage.toString('hex');
        const key = crypto.randomBytes(32).toString('hex');
        const res = await boltzClient.createReverseSwap({
          from: 'BTC', to: 'BTC', invoiceAmount: s.sourceAmount,
          claimPublicKey: key,
          preimageHash: crypto.createHash('sha256').update(preimage).digest('hex'),
        });
        swapServiceId = res.id;
        // Save pending swap with preimage for recovery
        await Swap.create({
          swapId, userId: userState?.userId || 'unknown',
          direction: s.direction,
          sourceChain: s.sourceChain, destChain: s.destChain,
          sourceAmount: s.sourceAmount!, destAmount: res.expectedAmount,
          sourceCurrency: 'BTC', destCurrency: 'BTC',
          boltzSwapId: swapServiceId, boltzStatus: 'swap.created',
          commissionRate: s.fee?.commissionRate || 0,
          commissionAmount: s.fee?.commissionAmount || 0,
          botProfit: s.fee?.botProfit || 0,
          preimage: preimageHex,
          status: 'pending',
        });
        await ctx.editMessageText(
          'Intercambio creado! (Lightning -> On-chain)\n\n' +
          'Paga esta invoice desde tu wallet Lightning:\n\n' +
          '`' + res.invoice + '`\n\n' +
          'Monto: ' + s.sourceAmount.toLocaleString() + ' sats\n' +
          'Al pagar, se completa solo. Tiempo: 1-5 min.',
        );
      } else {
        if (!s.invoice) { await ctx.editMessageText('Falta la invoice. Usa /swap.'); clearSs(ctx); return; }
        const res = await boltzClient.createSubmarineSwap({
          from: 'BTC', to: 'BTC', invoice: s.invoice,
          refundPublicKey: crypto.randomBytes(32).toString('hex'),
        });
        swapServiceId = res.id;
        // Save pending swap (no preimage needed for submarine)
        await Swap.create({
          swapId, userId: userState?.userId || 'unknown',
          direction: s.direction,
          sourceChain: s.sourceChain, destChain: s.destChain,
          sourceAmount: s.sourceAmount!, destAmount: res.expectedAmount,
          sourceCurrency: 'BTC', destCurrency: 'BTC',
          boltzSwapId: swapServiceId, boltzStatus: 'swap.created',
          commissionRate: s.fee?.commissionRate || 0,
          commissionAmount: s.fee?.commissionAmount || 0,
          botProfit: s.fee?.botProfit || 0,
          status: 'pending',
        });
        await ctx.editMessageText(
          'Intercambio creado! (On-chain -> Lightning)\n\n' +
          'Envia exactamente ' + res.expectedAmount.toLocaleString() + ' sats a:\n\n' +
          '`' + res.address + '`\n\n' +
          'Al confirmarse, se envia a tu Lightning. Tiempo: 10-30 min.',
        );
      }

      if (boltzWebSocket && chatId && messageId) {
        boltzWebSocket.subscribe(swapServiceId, (_id, status) => {
          updateSwapMessage(chatId, messageId, status, swapId, s, swapServiceId, userState?.userId).catch(() => {});
        });
      }
      setTimeout(() => boltzWebSocket?.unsubscribe(swapServiceId), 30 * 60 * 1000);
      clearSs(ctx);
      await ctx.reply('Usa /swap para un nuevo intercambio.');

    } catch (error) {
      logger.error('Swap creation failed', { error, swapId });
      const errMsg = error instanceof Error ? error.message : '';
      await ctx.editMessageText(
        'No se pudo crear el intercambio.\n\n' +
        (errMsg.includes('invoice') ? 'La invoice no es válida.\n\n' : '') +
        (errMsg.includes('pair') ? 'Par no disponible.\n\n' : '') +
        'Intenta de nuevo con /swap.',
      );
      clearSs(ctx);
    }
    return;
  }

  // === USDT/USDC ROUTE: ChangeNOW ===
  const cnClient = getCNClient();
  if (!cnClient) {
    await ctx.editMessageText('Cambios USDT/USDC no configurados.');
    clearSs(ctx); return;
  }

  try {
    const ticker = cnClient.getTicker(s.currency as 'USDT' | 'USDC', s.sourceChain || 'TRC-20');
    if (!ticker) { await ctx.editMessageText('Red no soportada.'); clearSs(ctx); return; }

    const toCurrency = s.destChain === 'LIGHTNING' ? 'btcln' : 'btc';
    const fromAmount = String(s.sourceAmount / 100);
    const estimate = await cnClient.estimate(ticker, toCurrency, fromAmount);

    const exchange = await cnClient.createExchange({
      fromCurrency: ticker, toCurrency,
      fromAmount, toAmount: estimate.estimatedAmount,
      address: s.destAddress || 'bc1q_required',
      flow: 'fixed-rate', rateId: estimate.rateId,
    });

    // Persist swap record for ChangeNOW exchanges
    try {
      await Swap.create({
        swapId,
        userId: userState?.userId || 'unknown',
        direction: s.direction,
        sourceChain: s.sourceChain,
        destChain: s.destChain,
        sourceAmount: Math.round(parseFloat(fromAmount) * 100),
        destAmount: Math.round(parseFloat(estimate.estimatedAmount) * 100_000_000),
        sourceCurrency: s.currency || 'USDT',
        destCurrency: 'BTC',
        boltzSwapId: exchange.id,
        boltzStatus: 'waiting',
        commissionRate: s.fee?.commissionRate || commissionEngine.getCommissionRate(),
        commissionAmount: s.fee?.commissionAmount || 0,
        botProfit: s.fee?.botProfit || 0,
        status: 'pending',
      });
    } catch (dbError) {
      logger.error('Failed to persist ChangeNOW swap record', { error: dbError, swapId });
    }

    // Track earnings and raffle for ChangeNOW swaps too
    if (s.fee) {
      raffleEngine.trackSwapVolume(userState?.userId || 'unknown', s.sourceAmount!).catch((err) => {
        logger.error('Raffle tracking failed for CN swap', { error: err, swapId });
      });
      treasuryEngine.trackEarnings(s.fee.commissionAmount).catch((err) => {
        logger.error('Treasury tracking failed for CN swap', { error: err, swapId });
      });
    }

    clearSs(ctx);

    await ctx.editMessageText(
      'Intercambio creado!\n\n' +
      'Envia ' + fromAmount + ' ' + (s.currency || 'USDT') + ' (' + (s.sourceChain || '') + ') a:\n\n' +
      '`' + exchange.payinAddress + '`\n\n' +
      'Recibirás: ~' + estimate.estimatedAmount + ' ' + toCurrency.toUpperCase() + '\n' +
      'Al confirmar, se envía automáticamente.',
    );

  } catch (error) {
    logger.error('ChangeNOW swap failed', { error, swapId });
    await ctx.editMessageText('No se pudo crear el intercambio. Intenta de nuevo con /swap.');
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
    'transaction.mempool': 'Tx detectada en la red.',
    'transaction.confirmed': 'Confirmada. Procesando...',
    'invoice.pending': 'Pagando invoice...',
    'invoice.paid': 'Invoice pagada. Completando...',
    'transaction.claim.pending': 'Casi listo...',
    'transaction.claimed': 'Completado!',
    'invoice.settled': 'Completado!',
    'invoice.failedToPay': 'Error en el pago. Fondos reembolsados.',
    'swap.expired': 'Expiro. Fondos reembolsados.',
    'transaction.lockupFailed': 'Error en deposito.',
    'transaction.failed': 'Error. Fondos reembolsados.',
    'transaction.refunded': 'Reembolsado.',
  };

  const msg = labels[status] || ('Estado: ' + status);

  try {
    await botInstance.telegram.editMessageText(chatId, messageId, undefined,
      'Intercambio: ' + swapId + '\n\n' + msg);

    if (status === 'transaction.claimed' || status === 'invoice.settled') {
      // Update the pending swap record (created at swap initiation)
      await Swap.findOneAndUpdate(
        { swapId },
        {
          boltzStatus: status,
          destAmount: session.fee?.estimatedReceive || 0,
          status: 'completed',
          completedAt: new Date(),
        },
        { upsert: true },
      );
      // Increment user swap counter and volume
      if (userId && userId !== 'unknown') {
        User.findOneAndUpdate(
          { telegramId: userId },
          { $inc: { swapsCount: 1, totalVolume: session.sourceAmount || 0 } },
        ).catch((err) => logger.error('Failed to update user stats', { error: err, userId }));
      }
      if (session.fee) {
        raffleEngine.trackSwapVolume(userId || 'unknown', session.sourceAmount!).catch((err) => {
          logger.error('Raffle tracking failed', { error: err, swapId });
        });
        treasuryEngine.trackEarnings(session.fee.commissionAmount).catch((err) => {
          logger.error('Treasury tracking failed', { error: err, swapId });
        });
      }
    }
  } catch { /* message deleted */ }
}
