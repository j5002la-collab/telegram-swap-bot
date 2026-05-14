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
import { getWalletAddress, isWalletReady, sendToAddress } from '../../engine/wallet';
import type { BoltzSwapStatus } from '../../boltz/types';
import bolt11 from 'bolt11';
import crypto from 'crypto';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';

const ECPair = ECPairFactory(ecc);

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
  logger.debug('Swap step: currency selected', { data, userId: ctx.from?.id });
  if (data === 'swap_cancel') { clearSs(ctx); await ctx.editMessageText('Cancelado.'); return; }
  if (data === 'swap_cur_disabled') { await ctx.answerCbQuery('Se necesita configurar API key'); return; }

  const currency = data.replace('swap_cur_', '') as 'BTC' | 'USDT' | 'USDC';
  const s = ss(ctx) || { step: 'currency' as const };
  s.currency = currency;

  if (currency === 'BTC') {
    s.step = 'direction';
    s.sourceChain = 'BTC';
    setSs(ctx, s);
    logger.debug('Swap: BTC selected → direction menu', { userId: ctx.from?.id });
    await showDirectionMenu(ctx);
  } else {
    s.step = 'network';
    setSs(ctx, s);
    logger.debug('Swap: stablecoin selected → network menu', { currency, userId: ctx.from?.id });
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
  logger.debug('Swap: network selected', { data, userId: ctx.from?.id });
  if (data === 'swap_cancel') { clearSs(ctx); await ctx.editMessageText('Cancelado.'); return; }
  const s = ss(ctx); if (!s) return;
  s.sourceChain = data.replace('swap_net_', '') as ChainNetwork;
  s.step = 'direction';
  setSs(ctx, s);
  logger.debug('Swap: network → direction menu', { sourceChain: s.sourceChain, currency: s.currency, userId: ctx.from?.id });
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
    // ChangeNOW only supports BTC on-chain — skip direction, go to address
    const cur = s.currency || 'USDT';
    s.step = 'address';
    s.direction = 'LN2ONCHAIN';
    s.destChain = 'BTC';
    setSs(ctx, s);
    logger.debug('Swap: ChangeNOW → direct to address', { currency: cur, sourceChain: s.sourceChain });
    await ctx.editMessageText(
      cur + ' → BTC (on-chain)\n\n' +
      'Pega tu dirección BTC (bc1...) donde recibirás los fondos.',
      Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
    );
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
  logger.debug('Swap: direction selected', { direction: dir, currency: s.currency, destChain: s.destChain, userId: ctx.from?.id });

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
    logger.debug('Swap: direction → waiting for address', { destType, step: 'address', userId: ctx.from?.id });
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
export async function handleSwapInvoice(ctx: Context, next: () => Promise<void>): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) return next();
  const s = ss(ctx);
  const raw = ctx.message.text.trim();
  logger.debug('📥 handleSwapInvoice fired', { step: s?.step, isInvoice: raw.startsWith('ln'), userId: ctx.from?.id });
  if (!s || s.step !== 'invoice') {
    if (raw.startsWith('lnbc') && s) {
      logger.warn('handleSwapInvoice: session step mismatch', { step: s.step, expected: 'invoice' });
    }
    return next(); // ← let next handler try
  }

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
export async function handleSwapAddress(ctx: Context, next: () => Promise<void>): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) return next();
  const s = ss(ctx);
  logger.debug('📥 handleSwapAddress fired', { step: s?.step, userId: ctx.from?.id });
  if (!s || s.step !== 'address') return next(); // ← let next handler try

  const raw = ctx.message.text.trim();
  if (!raw || raw.length < 10) {
    await ctx.reply('Dirección muy corta. Pega tu invoice Lightning (lnbc...) o dirección BTC (bc1...).');
    return;
  }

  try {
    s.destAddress = raw;
    logger.info('Address saved', { addr: raw.slice(0, 20) + '...' });

    // If destination is Lightning and user pasted an invoice, decode the amount
    const isLightningDest = s.destChain === 'LIGHTNING';
    const isInvoice = raw.startsWith('lnbc');
    let invoiceAmountSats: number | null = null;

    if (isLightningDest && isInvoice) {
      invoiceAmountSats = decodeInvoiceAmount(raw);
      logger.debug('Swap: LN invoice decoded for address', { hasAmount: invoiceAmountSats !== null, amountSats: invoiceAmountSats });
    }

    if (invoiceAmountSats && invoiceAmountSats > 0) {
      // Invoice has amount → show it and still ask for source USD amount
      s.step = 'amount';
      setSs(ctx, s);
      const btcAmount = (invoiceAmountSats / 100_000_000).toFixed(8);
      await ctx.reply(
        `📥 Invoice detectada: recibirás ~${invoiceAmountSats.toLocaleString()} sats (${btcAmount} BTC)\n\n` +
        'Ahora ingresa cuánto quieres ENVIAR en USD:\n' +
        'Ejemplo: 50 ($50 USD)\n\n' +
        'Responde con el número.',
        Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
      );
    } else {
      // No amount detected → ask for USD amount
      s.step = 'amount';
      setSs(ctx, s);
      await ctx.reply(
        (isLightningDest
          ? 'Dirección guardada. La invoice no tiene monto incluido.\n\n'
          : 'Dirección guardada. ') +
        'Ahora ingresa el monto en USD:\n' +
        'Ejemplo: 100 ($100 USD)\n\n' +
        'Responde con el número.',
        Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
      );
    }
  } catch (err) {
    logger.error('Failed to save address', { error: err });
    await ctx.reply('Error al guardar la dirección. Intenta de nuevo.');
  }
}

export async function handleSwapAmount(ctx: Context, next: () => Promise<void>): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) return next();
  const s = ss(ctx);
  logger.debug('📥 handleSwapAmount fired', { step: s?.step, userId: ctx.from?.id });
  if (!s || s.step !== 'amount') return next(); // ← let next handler try

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

  logger.debug('Swap: processing amount', { amount, currency: s.currency, direction: s.direction, userId: ctx.from?.id });

  try {
    // --- Fetch real rates depending on currency ---
    let rateInfo: RateInfo | null = null;
    const isBTC = s.currency === 'BTC';

    if (isBTC) {
      const isReverse = s.direction === 'LN2ONCHAIN';
      logger.debug('Swap: fetching BTC rate from rateEngine', { isReverse });
      const t0 = Date.now();
      rateInfo = await rateEngine.getRate(
        isReverse ? 'reverse' : 'submarine',
        'BTC',
        'BTC',
      );
      logger.debug('Swap: rateEngine response', { isReverse, found: !!rateInfo, ms: Date.now() - t0 });
    } else if (s.currency === 'USDT' || s.currency === 'USDC') {
      // USDT/USDC: attempt ChangeNOW estimate for real rate display
      logger.debug('Swap: fetching ChangeNOW estimate', { currency: s.currency, network: s.sourceChain });
      const cnClient = getCNClient();
      if (cnClient) {
        try {
          const fromAsset = cnClient.getTicker(s.currency, s.sourceChain || 'TRC-20');
          const toAsset = cnClient.getBTCDest();
          if (fromAsset) {
            const fromAmount = String(amount / 100);
            const t0 = Date.now();
            const estimate = await cnClient.estimate(fromAsset.ticker, toAsset.ticker, fromAmount, fromAsset.network, toAsset.network);
            logger.debug('Swap: ChangeNOW estimate response', { from: `${fromAsset.ticker}:${fromAsset.network}`, to: toAsset.ticker, ms: Date.now() - t0 });
            rateInfo = {
              boltzRate: parseFloat((estimate.toAmount || estimate.estimatedAmount || '0')) / parseFloat(fromAmount),
              userRate: parseFloat((estimate.toAmount || estimate.estimatedAmount || '0')) / parseFloat(fromAmount),
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
      const isFiat = !isBTC;
      const minDisplay = isFiat ? `$${(rateInfo.minAmount / 100).toFixed(2)} USD` : `${rateInfo.minAmount.toLocaleString()} sats`;
      await ctx.reply(`Monto muy bajo. Mínimo ${minDisplay}.`);
      return;
    }
    if (amount > rateInfo.maxAmount) {
      const isFiat = !isBTC;
      const maxDisplay = isFiat ? `$${(rateInfo.maxAmount / 100).toFixed(2)} USD` : `${rateInfo.maxAmount.toLocaleString()} sats`;
      await ctx.reply(`Monto muy alto. Máximo ${maxDisplay}.`);
      return;
    }

    const isSubmarine = s.direction === 'ONCHAIN2LN';
    const isReverse = s.direction === 'LN2ONCHAIN';

    let sourceAmount: number;
    let receiveAmount: number;
    let fee: FeeBreakdown;

    if (isBTC && isSubmarine) {
      // Submarine: user sends on-chain, receives Lightning.
      // 'amount' is the invoice amount (what user RECEIVES).
      // We must calculate how much they need to SEND to cover fees.
      const invoiceAmount = amount;
      const totalFeePct = rateInfo.botCommissionPct + rateInfo.boltzFeePct;
      // sourceAmount = (invoiceAmount + minerFee) / (1 - totalFeePct/100)
      sourceAmount = Math.ceil((invoiceAmount + rateInfo.boltzMinerFee) / (1 - totalFeePct / 100));
      receiveAmount = invoiceAmount;

      // Calculate actual fees based on source amount
      const commissionAmount = Math.floor(sourceAmount * (rateInfo.botCommissionPct / 100));
      const boltzFeeAmount = Math.ceil(sourceAmount * (rateInfo.boltzFeePct / 100));
      const raffleContribution = Math.floor(sourceAmount * 0.001);

      fee = {
        sourceAmount,
        commissionRate: rateInfo.botCommissionPct,
        commissionAmount,
        boltzFeeRate: rateInfo.boltzFeePct,
        boltzFeeAmount,
        boltzMinerFee: rateInfo.boltzMinerFee,
        totalFees: commissionAmount + boltzFeeAmount + rateInfo.boltzMinerFee,
        netSwapAmount: sourceAmount - commissionAmount - boltzFeeAmount - rateInfo.boltzMinerFee,
        estimatedReceive: receiveAmount,
        botProfit: commissionAmount,
      };

      s.sourceAmount = sourceAmount;
      s.fee = fee;
      s.step = 'confirm';
      setSs(ctx, s);

      const lines = [
        '📋 *Resumen de tu swap*',
        '',
        `Envías: ${sourceAmount.toLocaleString()} sats on-chain`,
        `Recibes en Lightning: ${receiveAmount.toLocaleString()} sats (tu invoice)`,
        '',
        '*Comisiones incluidas:*',
        `  ├── SwapBot (${rateInfo.botCommissionPct}%): ${commissionAmount.toLocaleString()} sats`,
        `  ├── Red Boltz (${rateInfo.boltzFeePct}%): ${boltzFeeAmount.toLocaleString()} sats`,
        `  ├── Minería: ${rateInfo.boltzMinerFee} sats`,
        `  └── Sorteo (0.1%): ${raffleContribution.toLocaleString()} sats`,
        '',
        `⏱ Tiempo estimado: 10-30 minutos`,
      ];

      await ctx.reply(lines.join('\n'), Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirmar', 'swap_confirm'), Markup.button.callback('❌ Cancelar', 'swap_cancel')],
      ]));
      return;
    }

    // Reverse (LN→Chain) or ChangeNOW: amount is source
    sourceAmount = amount;
    fee = commissionEngine.calculateFeeBreakdown(sourceAmount, rateInfo);
    receiveAmount = fee.estimatedReceive;

    s.sourceAmount = sourceAmount;
    s.rateInfo = rateInfo;
    s.fee = fee;
    s.step = 'confirm';
    setSs(ctx, s);

    const sourceLabel = isBTC ? 'sats' : (s.currency || 'USDT');
    const destLabel = isBTC ? 'sats' : 'BTC';
    const msg = commissionEngine.formatBreakdown(fee, sourceLabel, destLabel);

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

  logger.debug('Swap: confirm — executing swap', { swapId, direction: s.direction, amount: s.sourceAmount, currency: s.currency, userId: userState?.userId });

  await ctx.editMessageText('Creando intercambio...');

  // === BTC ROUTE ===
  if (s.currency === 'BTC') {
    try {
      const isReverse = s.direction === 'LN2ONCHAIN';
      let swapServiceId: string;
      let preimageHex: string | undefined;

      if (isReverse) {
        logger.debug('Swap: creating Boltz reverse swap', { amount: s.sourceAmount });
        const t0 = Date.now();
        const preimage = crypto.randomBytes(32);
        preimageHex = preimage.toString('hex');
        const claimKeys = ECPair.makeRandom();
        const res = await boltzClient.createReverseSwap({
          from: 'BTC', to: 'BTC', invoiceAmount: s.sourceAmount,
          claimPublicKey: Buffer.from(claimKeys.publicKey).toString('hex'),
          preimageHash: crypto.createHash('sha256').update(preimage).digest('hex'),
        });
        swapServiceId = res.id;
        logger.debug('Swap: Boltz reverse swap created', { boltzId: res.id, ms: Date.now() - t0 });
        // Save pending swap with preimage for recovery
        await Swap.create({
          swapId, userId: userState?.userId || 'unknown',
          direction: s.direction,
          sourceChain: s.sourceChain, destChain: s.destChain,
          sourceAmount: s.sourceAmount!, destAmount: res.expectedAmount || s.sourceAmount || 0,
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

        const useIntermediary = false; // disabled — deposit monitoring needs debugging

        if (useIntermediary) {
          // Intermediary mode: user deposits to OUR wallet, we forward to Boltz
          const ourAddress = getWalletAddress();
          await Swap.create({
            swapId, userId: userState?.userId || 'unknown',
            direction: s.direction,
            sourceChain: s.sourceChain, destChain: s.destChain,
            sourceAmount: s.sourceAmount!, destAmount: s.fee?.estimatedReceive || 0,
            sourceCurrency: 'BTC', destCurrency: 'BTC',
            boltzSwapId: '', boltzStatus: 'waiting_deposit',
            commissionRate: s.fee?.commissionRate || 0,
            commissionAmount: s.fee?.commissionAmount || 0,
            botProfit: s.fee?.botProfit || 0,
            status: 'pending',
          });

          await ctx.editMessageText(
            '🏦 *Deposita a nuestra wallet*\n\n' +
            'Envía **' + s.sourceAmount!.toLocaleString() + ' sats** a:\n\n' +
            '`' + ourAddress + '`\n\n' +
            'Al confirmarse el depósito, crearemos el swap con Boltz\n' +
            'y pagaremos tu invoice Lightning de ' +
            (s.fee?.estimatedReceive?.toLocaleString() || '?') + ' sats.\n\n' +
            '⏱ Tiempo estimado: 10-60 minutos',
          );

          // Start background deposit monitoring
          if (chatId && messageId) {
            monitorDepositAndSwap(swapId, s, chatId, messageId, userState?.userId).catch((err) => {
              logger.error('Deposit monitor failed', { error: err, swapId });
            });
          }
        } else {
          // Direct mode: create Boltz swap immediately
          logger.debug('Swap: creating Boltz submarine swap', { invoiceLen: s.invoice.length });
          const t0 = Date.now();
          const refundKeys = ECPair.makeRandom();
          const res = await boltzClient.createSubmarineSwap({
            from: 'BTC', to: 'BTC', invoice: s.invoice,
            refundPublicKey: Buffer.from(refundKeys.publicKey).toString('hex'),
          });
          swapServiceId = res.id;
          logger.debug('Swap: Boltz submarine swap created', { boltzId: res.id, ms: Date.now() - t0 });
          await Swap.create({
            swapId, userId: userState?.userId || 'unknown',
            direction: s.direction,
            sourceChain: s.sourceChain, destChain: s.destChain,
            sourceAmount: s.sourceAmount!, destAmount: res.expectedAmount || s.sourceAmount || 0,
            sourceCurrency: 'BTC', destCurrency: 'BTC',
            boltzSwapId: swapServiceId, boltzStatus: 'swap.created',
            commissionRate: s.fee?.commissionRate || 0,
            commissionAmount: s.fee?.commissionAmount || 0,
            botProfit: s.fee?.botProfit || 0,
            status: 'pending',
          });

          // Brief confirm on original message
          await ctx.editMessageText('✅ Intercambio creado!');

          // Send address in NEW persistent message
          const addrMsg = await ctx.reply(
            '📤 *Envía exactamente* **' + res.expectedAmount.toLocaleString() + ' sats** a:\n\n' +
            '`' + res.address + '`\n\n' +
            '⏳ _Esperando transacción on-chain..._',
          );

          // Use the NEW message for WebSocket status updates
          if (boltzWebSocket && addrMsg.message_id) {
            const wsChatId = addrMsg.chat.id;
            const wsMsgId = addrMsg.message_id;
            logger.debug('Swap: subscribing to WebSocket', { boltzId: swapServiceId });
            boltzWebSocket.subscribe(swapServiceId, (_id, status) => {
              logger.debug('Swap: WS status update', { boltzId: swapServiceId, status });
              updateSwapMessage(wsChatId, wsMsgId, status, swapId, s, swapServiceId, userState?.userId).catch(() => {});
            });
            setTimeout(() => boltzWebSocket?.unsubscribe(swapServiceId!), 30 * 60 * 1000);
          }
        }
      }

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
    const fromAsset = cnClient.getTicker(s.currency as 'USDT' | 'USDC', s.sourceChain || 'TRC-20');
    if (!fromAsset) { await ctx.editMessageText('Red no soportada.'); clearSs(ctx); return; }

    const toAsset = cnClient.getBTCDest();
    const fromAmount = String(s.sourceAmount / 100);
    const estimate = await cnClient.estimate(fromAsset.ticker, toAsset.ticker, fromAmount, fromAsset.network, toAsset.network);

    const exchange = await cnClient.createExchange({
      fromCurrency: fromAsset.ticker, toCurrency: toAsset.ticker,
      fromNetwork: fromAsset.network, toNetwork: toAsset.network,
      fromAmount, toAmount: (estimate.toAmount || estimate.estimatedAmount || '0'),
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
        destAmount: Math.round(parseFloat((estimate.toAmount || estimate.estimatedAmount || '0')) * 100_000_000),
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
      '⏳ Intercambio creado!\n\n' +
      'Envia **' + fromAmount + ' ' + (s.currency || 'USDT') + '** (' + (s.sourceChain || '') + ') a:\n\n' +
      '`' + exchange.payinAddress + '`\n\n' +
      'Recibiras: ~' + (estimate.toAmount || estimate.estimatedAmount || '0') + ' BTC\n\n' +
      '🔍 _Esperando deposito..._',
    );

    // Start polling for status updates on the edited message
    if (chatId && messageId) {
      startCNPolling(exchange.id, swapId, chatId, messageId).catch((err) => {
        logger.error('CN polling failed', { error: err, cnId: exchange.id });
      });
    }

  } catch (error: any) {
    const status = error?.response?.status;
    const errMsg = status === 401
      ? '\n\n🔑 Error de API key. Verifica CHANGENOW_API_KEY en .env'
      : status === 404
      ? '\n\n🔍 Par de intercambio no disponible para esta red.'
      : '';
    logger.error('ChangeNOW swap failed', { error, swapId, status });
    await ctx.editMessageText('No se pudo crear el intercambio.' + errMsg + '\n\nIntenta de nuevo con /swap.');
    clearSs(ctx);
  }
}

// ============================================================
// ChangeNOW status polling
// ============================================================
const CN_STATUS_LABELS: Record<string, string> = {
  waiting: '⏳ Esperando tu depósito...',
  confirming: '🔍 Depósito detectado, esperando confirmaciones...',
  exchanging: '🔄 Intercambiando...',
  sending: '📤 Enviando BTC a tu dirección...',
  finished: '✅ ¡Intercambio completado!',
  failed: '❌ Error en el intercambio.',
  refunded: '↩️ Reembolsado.',
};

async function startCNPolling(
  cnId: string, swapId: string, chatId: number, messageId: number,
): Promise<void> {
  const cnClient = getCNClient();
  if (!cnClient || !botInstance) return;

  const maxPolls = 120; // 30 minutes at 15s intervals
  let lastStatus = '';

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, 15_000));

    try {
      const status = await cnClient.getStatus(cnId);
      logger.debug('CN polling status', { cnId, status: status.status, poll: i + 1 });

      if (status.status !== lastStatus) {
        lastStatus = status.status;

        let msg = '🔁 Swap #' + swapId + '\n\n';
        msg += (CN_STATUS_LABELS[status.status] || ('Estado: ' + status.status));

        if (status.payoutHash && status.status === 'finished') {
          msg += '\n\n📋 Tx BTC: `' + status.payoutHash + '`';
          // Update swap record
          await Swap.findOneAndUpdate(
            { swapId },
            { status: 'completed', boltzStatus: status.status, completedAt: new Date() },
          ).catch(() => {});
        }

        await botInstance.telegram.editMessageText(chatId, messageId, undefined, msg).catch(() => {});
      }

      // Terminal states
      if (['finished', 'failed', 'refunded'].includes(status.status)) {
        if (status.status !== 'finished') {
          await Swap.findOneAndUpdate(
            { swapId },
            { status: status.status === 'refunded' ? 'refunded' : 'failed', boltzStatus: status.status },
          ).catch(() => {});
        }
        return;
      }
    } catch (err) {
      logger.warn('CN polling error', { cnId, error: err });
    }
  }

  // Timeout
  try {
    await botInstance.telegram.editMessageText(chatId, messageId, undefined,
      '⏰ Swap #' + swapId + '\n\nTiempo límite alcanzado. Si enviaste los fondos, contacta a soporte con el ID: `' + cnId + '`',
    );
  } catch { /* ignore */ }
}

// ============================================================
// Intermediary deposit → swap flow
// ============================================================
async function monitorDepositAndSwap(
  swapId: string, session: SwapSession, chatId: number, messageId: number, userId?: string,
): Promise<void> {
  if (!botInstance) return;
  const s = session;

  try {
    // Poll for deposit
    const { default: axios } = await import('axios');
    const maxPolls = 180; // 60 min at 20s intervals
    const ourAddress = getWalletAddress();

    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, 20_000));

      try {
        const url = `https://mempool.space/api/address/${ourAddress}/txs`;
        const { data } = await axios.get(url, { timeout: 10000 });

        // Find a tx sending at least the expected amount to our address
        const expectedAmount = s.sourceAmount || 0;
        let found = false;

        for (const tx of data) {
          for (const vout of tx.vout) {
            if (vout.scriptpubkey_address === ourAddress) {
              const receivedSats = Math.round(vout.value * 100_000_000);
              if (receivedSats >= expectedAmount && tx.status.confirmed) {
                found = true;
                logger.info('Deposit confirmed for swap', { swapId, txid: tx.txid, amount: receivedSats });

                // Deduct commission + raffle
                const commissionAmount = s.fee?.commissionAmount || 0;
                const raffleAmount = Math.floor(expectedAmount * 0.001);
                await treasuryEngine.trackEarnings(commissionAmount).catch(() => {});
                await raffleEngine.trackSwapVolume(userId || 'unknown', expectedAmount).catch(() => {});

                // Create Boltz submarine swap
                const refundKeys = ECPair.makeRandom();
                const res = await boltzClient.createSubmarineSwap({
                  from: 'BTC', to: 'BTC',
                  invoice: s.invoice!,
                  refundPublicKey: Buffer.from(refundKeys.publicKey).toString('hex'),
                });

                logger.info('Boltz swap created via intermediary', { swapId, boltzId: res.id });

                // Auto-send BTC from our wallet to Boltz address
                const sendResult = await sendToAddress(res.address, res.expectedAmount);

                if (sendResult) {
                  // Update swap record
                  await Swap.findOneAndUpdate(
                    { swapId },
                    { boltzSwapId: res.id, boltzStatus: 'invoice.set',
                      status: 'pending', completedAt: undefined },
                  ).catch(() => {});

                  await botInstance.telegram.editMessageText(chatId, messageId, undefined,
                    '✅ Depósito recibido: ' + receivedSats.toLocaleString() + ' sats\n\n' +
                    '📤 Enviado a Boltz: `' + sendResult + '`\n\n' +
                    'Swap creado: `' + res.id + '`\n' +
                    'Recibirás ' + (s.fee?.estimatedReceive?.toLocaleString() || '?') + ' sats en Lightning.\n\n' +
                    '⏳ _Esperando que Boltz procese el pago..._',
                  );

                  // Subscribe to WebSocket for Boltz updates
                  if (boltzWebSocket) {
                    boltzWebSocket.subscribe(res.id, (_id, status) => {
                      updateSwapMessage(chatId, messageId, status, swapId, s, res.id, userId).catch(() => {});
                    });
                    setTimeout(() => boltzWebSocket?.unsubscribe(res.id), 30 * 60 * 1000);
                  }
                } else {
                  await botInstance.telegram.editMessageText(chatId, messageId, undefined,
                    '✅ Depósito recibido: ' + receivedSats.toLocaleString() + ' sats\n\n' +
                    '⚠️ Error al enviar a Boltz. Swap #' + swapId + '.\n\n' +
                    'Contacta a soporte con este ID.',
                  );
                }

                return;
              }
            }
          }
        }

        if (i % 3 === 0) {
          logger.debug('Still waiting for intermediary deposit', { swapId, poll: i + 1 });
        }
      } catch {
        // polling error, continue
      }
    }

    // Timeout
    await botInstance.telegram.editMessageText(chatId, messageId, undefined,
      '⏰ Tiempo de espera agotado para el swap #' + swapId + '.\n\n' +
      'Si realizaste el depósito, contacta a soporte.',
    ).catch(() => {});
  } catch (error) {
    logger.error('Intermediary monitor failed', { error, swapId });
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
    'swap.created': '⏳ Swap creado. Esperando tu transacción...',
    'invoice.set': '📋 Invoice validada. Envía tus BTC a la dirección indicada.',
    'transaction.mempool': '🔍 Transacción detectada en la red (mempool). Esperando confirmación...',
    'transaction.confirmed': '✅ Transacción confirmada. Boltz está pagando tu invoice Lightning...',
    'invoice.pending': '⚡ Pagando invoice Lightning...',
    'invoice.paid': '💰 Invoice pagada. Completando swap...',
    'transaction.claim.pending': '🔐 Finalizando swap...',
    'transaction.claimed': '🎉 ¡Swap completado! Tus fondos fueron enviados.',
    'invoice.settled': '🎉 ¡Swap completado! Tus fondos fueron enviados.',
    'invoice.failedToPay': '❌ Error: No se pudo pagar la invoice. Fondos reembolsados.',
    'swap.expired': '⏰ Swap expirado. Tus fondos serán reembolsados.',
    'transaction.lockupFailed': '❌ Error en el depósito.',
    'transaction.failed': '❌ Error. Fondos reembolsados.',
    'transaction.refunded': '↩️ Fondos reembolsados.',
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
