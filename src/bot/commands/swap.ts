import { Context, Markup, Telegraf } from 'telegraf';
import { rateEngine, RateInfo } from '../../engine/rates';
import { commissionEngine, FeeBreakdown } from '../../engine/commission';
import { raffleEngine } from '../../engine/raffle';
import { treasuryEngine } from '../../engine/treasury';
import { getUserState } from '../middleware/user';
import { logger } from '../../utils/logger';
import { config } from '../../utils/config';
import { Swap, SwapDirection, ChainNetwork, User } from '../../models';
import { boltzClient } from '../../boltz/client';
import { BoltzWebSocket } from '../../boltz/websocket';
import { getCNClient } from '../../changenow/client';
import { getWalletAddress, isWalletReady, sendToAddress, getPublicKeyHex } from '../../engine/wallet';
import axios from 'axios';
import type { BoltzSwapStatus } from '../../boltz/types';
import bolt11 from 'bolt11';
import crypto from 'crypto';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';

const ECPair = ECPairFactory(ecc);

// --- Global state ---
let botInstance: Telegraf<Context> | null = null;
let boltzWebSocket: BoltzWebSocket | null = null;

/** Format a sats amount for display: < 1M sats → 'X sats', >= 1M → 'X.XXXXXXXX BTC' */
function formatSats(amountSats: number): string {
  if (amountSats < 1_000_000) return amountSats.toLocaleString() + ' sats';
  return (amountSats / 100_000_000).toFixed(8) + ' BTC (' + amountSats.toLocaleString() + ' sats)';
}

/** Minimum confirmations before creating Boltz swap:
 *  - <= 1M sats: 1 confirmation
 *  - 1M - 10M sats: 2 confirmations
 *  - > 10M sats: 3 confirmations */
function minConfirmations(amountSats: number): number {
  if (amountSats <= 1_000_000) return 1;
  if (amountSats <= 10_000_000) return 2;
  return 3;
}

/** Notify all configured admin IDs via Telegram */
async function notifyAdmins(message: string): Promise<void> {
  if (!botInstance || config.adminIds.length === 0) return;
  logger.warn('Notifying admins', { count: config.adminIds.length });
  for (const adminId of config.adminIds) {
    try {
      await botInstance.telegram.sendMessage(adminId, '🚨 *SwapBot Alert*\n\n' + message, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error('Failed to notify admin', { adminId, error: String(err) });
    }
  }
}

/** Fetch the current Bitcoin block height from mempool.space */
async function getTipHeight(): Promise<number> {
  try {
    const { data } = await axios.get('https://mempool.space/api/blocks/tip/height', { timeout: 5000 });
    return Number(data);
  } catch {
    return 0;
  }
}

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
  /** Boltz on-chain address where user must send BTC */
  boltzAddress?: string;
  /** Boltz expected amount in sats */
  boltzExpectedAmount?: number;
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
    buttons.push([Markup.button.callback('BTC -> USDT', 'swap_cur_BTC2USDT')]);
    buttons.push([Markup.button.callback('BTC -> USDC', 'swap_cur_BTC2USDC')]);
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

  const rawCurrency = data.replace('swap_cur_', '');
  const s = ss(ctx) || { step: 'currency' as const };

  // BTC → USDT / BTC → USDC (ChangeNOW reverse stablecoin swaps)
  if (rawCurrency === 'BTC2USDT' || rawCurrency === 'BTC2USDC') {
    const destCurrency = rawCurrency === 'BTC2USDT' ? 'USDT' : 'USDC';
    s.currency = 'BTC';
    s.destChain = destCurrency === 'USDT' ? 'TRC-20' : 'SOLANA'; // default, will be overridden
    s.step = 'direction';
    s.direction = rawCurrency === 'BTC2USDT' ? 'BTC2USDT' : 'BTC2USDC';
    setSs(ctx, s);
    await showBTCStableNetworkMenu(ctx, destCurrency);
    return;
  }

  const currency = rawCurrency as 'BTC' | 'USDT' | 'USDC';
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
// BTC → USDC / USDT: destination network selection
// ============================================================
async function showBTCStableNetworkMenu(ctx: Context, destCurrency: string): Promise<void> {
  const allNets = destCurrency === 'USDT'
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

  const buttons = allNets.map(n =>
    [Markup.button.callback(n.label + ' - ' + n.fee, 'swap_destnet_' + n.net)],
  );
  buttons.push([Markup.button.callback('Cancelar', 'swap_cancel')]);
  await ctx.editMessageText(
    'BTC → ' + destCurrency + ' — Selecciona la red de destino:',
    Markup.inlineKeyboard(buttons),
  );
}

export async function handleSwapDestNetwork(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  await ctx.answerCbQuery();
  const data = ctx.callbackQuery.data;
  logger.debug('Swap: dest network selected', { data, userId: ctx.from?.id });
  if (data === 'swap_cancel') { clearSs(ctx); await ctx.editMessageText('Cancelado.'); return; }
  const s = ss(ctx); if (!s) return;
  s.destChain = data.replace('swap_destnet_', '') as ChainNetwork;
  s.step = 'address';
  setSs(ctx, s);
  const destCur = s.direction === 'BTC2USDT' ? 'USDT' : 'USDC';
  logger.debug('Swap: BTC→stablecoin dest net → address', { destChain: s.destChain, destCurrency: destCur, userId: ctx.from?.id });
  await ctx.editMessageText(
    'BTC → ' + destCur + ' (' + s.destChain + ')\n\n' +
    'Pega tu dirección de ' + destCur + ' donde recibirás los fondos.',
    Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
  );
}

// ============================================================
// Step 2: Direction
// ============================================================
async function showDirectionMenu(ctx: Context): Promise<void> {
  const s = ss(ctx);
  const isBTC = !s || s.currency === 'BTC';

  if (isBTC) {
    // Check if this is BTC → stablecoin (handled by ChangeNOW)
    if (s?.direction === 'BTC2USDT' || s?.direction === 'BTC2USDC') {
      // BTC → stablecoin: skip direction, go to amount
      s.step = 'amount';
      setSs(ctx, s);
      const destCur = s.direction === 'BTC2USDT' ? 'USDT' : 'USDC';
      const destNet = s.destChain || 'TRC-20';
      await ctx.editMessageText(
        'BTC → ' + destCur + ' (' + destNet + ')\n\n' +
        'Ingresa cuántos sats quieres enviar:\n' +
        'Min: 50,000 sats\n\n' +
        'Responde con el número.',
        Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
      );
      return;
    }

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
  } else if (s.currency === 'BTC' && dir === 'LN2ONCHAIN') {
    // Lightning → On-chain: ask for destination BTC address first
    s.step = 'address';
    setSs(ctx, s);
    logger.debug('Swap: LN2ONCHAIN → waiting for BTC address', { userId: ctx.from?.id });
    await ctx.editMessageText(
      'Lightning → BTC On-chain\n\nPega tu dirección BTC (bc1...) donde recibirás los fondos.',
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
  logger.debug('📥 handleSwapAddress fired', { step: s?.step, direction: s?.direction, userId: ctx.from?.id });
  if (!s || s.step !== 'address') return next(); // ← let next handler try

  const raw = ctx.message.text.trim();
  if (!raw || raw.length < 10) {
    await ctx.reply('Dirección muy corta. Pega tu invoice Lightning (lnbc...) o dirección.');
    return;
  }

  // BTC → stablecoin: address is USDT/USDC destination
  if (s.direction === 'BTC2USDT' || s.direction === 'BTC2USDC') {
    s.destAddress = raw;
    s.step = 'amount';
    const destCur = s.direction === 'BTC2USDT' ? 'USDT' : 'USDC';
    setSs(ctx, s);
    logger.info('BTC→stablecoin address saved', { addr: raw.slice(0, 20) + '...', destCur, destNet: s.destChain });
    await ctx.reply(
      'Dirección ' + destCur + ' (' + (s.destChain || '') + ') guardada.\n\n' +
      'Ahora ingresa cuántos sats quieres ENVIAR:\n' +
      'Ejemplo: 100000 (100,000 sats)\n\n' +
      'Responde con el número.',
      Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
    );
    return;
  }

  // LN2ONCHAIN (real BTC Lightning → On-chain): destination is BTC address
  if (s.direction === 'LN2ONCHAIN' && s.currency === 'BTC') {
    // Validate: should start with bc1 (SegWit) or 1/3 (legacy)
    if (!raw.startsWith('bc1') && !raw.startsWith('1') && !raw.startsWith('3')) {
      await ctx.reply('Dirección BTC inválida. Debe empezar con bc1, 1, o 3.\n\nIntenta de nuevo.');
      return;
    }
    s.destAddress = raw;
    s.step = 'amount';
    setSs(ctx, s);
    logger.info('LN2ONCHAIN address saved', { addr: raw.slice(0, 20) + '...' });
    await ctx.reply(
      'Dirección BTC guardada: `' + raw.slice(0, 12) + '...`\n\n' +
      'Ahora ingresa cuántos sats quieres ENVIAR por Lightning:\n' +
      'Min: 25,000 | Max: 25,000,000\n\n' +
      'Responde con el número.',
      Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
    );
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
        'Ejemplo: 10 ($10 USD)\n\n' +
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

  // USDC/USDT: user enters dollars (e.g. 30 = $30), convert to cents
  const isStablecoin = s.currency === 'USDT' || s.currency === 'USDC';
  const finalAmount = isStablecoin ? amount * 100 : amount;

  await processAmount(ctx, finalAmount);
}

async function processAmount(ctx: Context, amount: number): Promise<void> {
  const s = ss(ctx);
  if (!s) return;

  logger.debug('Swap: processing amount', { amount, currency: s.currency, direction: s.direction, userId: ctx.from?.id });

  // --- BTC → USDC / USDT via ChangeNOW ---
  if (s.direction === 'BTC2USDT' || s.direction === 'BTC2USDC') {
    await processBTCStableAmount(ctx, amount);
    return;
  }

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

            // Calculate receive amount in sats directly from ChangeNOW response
            const btcEst = parseFloat(estimate.toAmount || estimate.estimatedAmount || '0');
            const receiveSats = Math.round(btcEst * 100_000_000);

            rateInfo = {
              boltzRate: btcEst / parseFloat(fromAmount),
              userRate: receiveSats / amount,  // sats per cent
              boltzFeePct: 0,
              boltzMinerFee: 0,
              botCommissionPct: 0,  // commission is internal
              botCommissionAmount: 0,
              minAmount: 1000,
              maxAmount: 2000000,
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

    if (!isBTC) {
      // ChangeNOW (USDC/USDT → BTC): clean display, no commission breakdown
      const usdAmount = (sourceAmount / 100).toFixed(2);
      const btcAmount = (receiveAmount / 100_000_000).toFixed(8);
      const lines = [
        '📋 *Resumen de tu swap*',
        '',
        `Envías: $${usdAmount} ${s.currency || 'USDT'} (${s.sourceChain})`,
        `Recibirás: ${receiveAmount.toLocaleString()} sats (${btcAmount} BTC)`,
        '',
        '⏱ Tiempo estimado: 5-30 minutos',
      ];
      await ctx.reply(lines.join('\n'), Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirmar', 'swap_confirm'), Markup.button.callback('❌ Cancelar', 'swap_cancel')],
      ]));
    } else {
      const sourceLabel = isBTC ? 'sats' : (s.currency || 'USDT');
      const destLabel = isBTC ? 'sats' : 'BTC';
      const msg = commissionEngine.formatBreakdown(fee, sourceLabel, destLabel);

      await ctx.reply(msg, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirmar', 'swap_confirm'), Markup.button.callback('❌ Cancelar', 'swap_cancel')],
      ]));
    }
  } catch (error) {
    logger.error('Process amount error', { error });
    await ctx.reply(SWAP_ERROR);
  }
}

// ============================================================
// BTC → USDC / USDT amount processing (ChangeNOW)
// ============================================================
async function processBTCStableAmount(ctx: Context, amount: number): Promise<void> {
  const s = ss(ctx);
  if (!s) return;

  const cnClient = getCNClient();
  if (!cnClient) {
    await ctx.reply('Cambios BTC→stablecoin no configurados (falta API key).');
    return;
  }

  const destCurrency = s.direction === 'BTC2USDT' ? 'USDT' : 'USDC';
  const destNet = s.destChain || 'TRC-20';

  // Validate min/max (BTC: 50k-25M sats)
  if (amount < 50000) {
    await ctx.reply('Monto muy bajo. Mínimo 50,000 sats.');
    return;
  }
  if (amount > 25_000_000) {
    await ctx.reply('Monto muy alto. Máximo 25,000,000 sats.');
    return;
  }

  try {
    // Get ChangeNOW ticker for destination
    const destAsset = cnClient.getTicker(destCurrency as 'USDT' | 'USDC', destNet);
    if (!destAsset) {
      await ctx.reply('Red de destino no soportada para ' + destCurrency + '.');
      return;
    }

    const btcAsset = cnClient.getBTCDest(); // BTC as source
    const btcAmount = (amount / 100_000_000).toFixed(8); // sats → BTC

    logger.debug('BTC→stablecoin: fetching estimate', {
      from: 'btc:btc', to: `${destAsset.ticker}:${destAsset.network}`, btcAmount,
    });

    const estimate = await cnClient.estimate(
      btcAsset.ticker, destAsset.ticker, btcAmount,
      btcAsset.network, destAsset.network,
    );

    const receiveAmount = parseFloat(estimate.toAmount || estimate.estimatedAmount || '0');
    const commissionAmount = Math.floor(amount * (commissionEngine.getCommissionRate() / 100));

    logger.info('BTC→stablecoin estimate', {
      sendSats: amount, receiveEst: receiveAmount, destCurrency, destNet,
      rateId: estimate.rateId,
    });

    const rateInfo: RateInfo = {
      boltzRate: receiveAmount / parseFloat(btcAmount),
      userRate: receiveAmount / parseFloat(btcAmount),
      boltzFeePct: 0.5,
      boltzMinerFee: 0,
      botCommissionPct: commissionEngine.getCommissionRate(),
      botCommissionAmount: 0,
      minAmount: 50000,
      maxAmount: 25000000,
      pairHash: estimate.rateId,
    };

    const fee = commissionEngine.calculateFeeBreakdown(amount, rateInfo);
    fee.estimatedReceive = Math.floor(receiveAmount * 100); // store as cents

    s.sourceAmount = amount;
    s.rateInfo = rateInfo;
    s.fee = fee;
    s.step = 'confirm';
    setSs(ctx, s);

    const lines = [
      '📋 *Resumen de tu swap*',
      '',
      `Envías: ${amount.toLocaleString()} sats (BTC)`,
      `Recibes: ~${receiveAmount.toFixed(6)} ${destCurrency} (${destNet})`,
      '',
      `Comisión SwapBot (${commissionEngine.getCommissionRate()}%): ${commissionAmount.toLocaleString()} sats`,
      '',
      '⏱ Tiempo estimado: 5-30 minutos',
    ];

    await ctx.reply(lines.join('\n'), Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirmar', 'swap_confirm'), Markup.button.callback('❌ Cancelar', 'swap_cancel')],
    ]));
  } catch (error) {
    logger.error('BTC→stablecoin estimate error', { error });
    await ctx.reply('Error al obtener cotización. Intenta de nuevo con /swap.');
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

  // === BTC ROUTE ===
  if (s.currency === 'BTC') {
    // --- BTC → USDC / USDT via ChangeNOW ---
    if (s.direction === 'BTC2USDT' || s.direction === 'BTC2USDC') {
      await executeBTCStableSwap(ctx, swapId, s, userState?.userId, chatId, messageId);
      return;
    }

    try {
      const isReverse = s.direction === 'LN2ONCHAIN';
      let swapServiceId: string;
      let preimageHex: string | undefined;

      if (isReverse) {
        if (!s.destAddress) { await ctx.editMessageText('Falta la dirección BTC. Usa /swap.'); clearSs(ctx); return; }

        logger.debug('Swap: creating Boltz reverse swap', { amount: s.sourceAmount, destAddr: s.destAddress.slice(0, 12) + '...' });
        const t0 = Date.now();
        const preimage = crypto.randomBytes(32);
        preimageHex = preimage.toString('hex');

        const walletReady = isWalletReady();
        // Use bot keyPair if available → BTC comes to our wallet → we forward
        const claimPubKey = walletReady
          ? getPublicKeyHex()!
          : Buffer.from(ECPair.makeRandom().publicKey).toString('hex');

        // walletReady → BTC goes to our wallet (config.btcAddress), we forward to user
        // !walletReady → BTC goes directly to user's destination address
        const swapDestAddress = walletReady ? getWalletAddress() : (s.destAddress || '');

        const res = await boltzClient.createReverseSwap({
          from: 'BTC', to: 'BTC', invoiceAmount: s.sourceAmount,
          claimPublicKey: claimPubKey,
          preimageHash: crypto.createHash('sha256').update(preimage).digest('hex'),
          address: swapDestAddress,
        });
        swapServiceId = res.id;

        // Calculate what user will receive (sourceAmount minus commission)
        const commissionAmount = s.fee?.commissionAmount || 0;
        const userReceives = (s.sourceAmount || 0) - commissionAmount;

        // Save pending swap (with recovery data)
        await Swap.create({
          swapId, userId: userState?.userId || 'unknown',
          direction: s.direction,
          sourceChain: s.sourceChain, destChain: s.destChain,
          sourceAmount: s.sourceAmount!, destAmount: walletReady ? userReceives : (res.expectedAmount || s.sourceAmount || 0),
          sourceCurrency: 'BTC', destCurrency: 'BTC',
          boltzSwapId: swapServiceId, boltzStatus: 'swap.created',
          commissionRate: s.fee?.commissionRate || 0,
          commissionAmount: walletReady ? commissionAmount : 0,
          botProfit: walletReady ? commissionAmount : 0,
          preimage: preimageHex,
          lockupAddress: res.lockupAddress,
          swapTree: res.swapTree,
          refundPublicKey: res.refundPublicKey,
          timeoutBlockHeight: res.timeoutBlockHeight,
          destAddress: s.destAddress,
          status: 'pending',
        });

        const lines = [
          '⚡ *Intercambio creado! (Lightning → On-chain)*',
          '',
          'Paga esta invoice desde tu wallet Lightning:',
          '`' + res.invoice + '`',
          '',
          `Monto a pagar: ${s.sourceAmount!.toLocaleString()} sats`,
        ];

        if (walletReady) {
          lines.push(`Recibirás en \`${s.destAddress.slice(0, 12)}...\`: ${userReceives.toLocaleString()} sats`);
          lines.push(`(Comisión SwapBot ${s.fee?.commissionRate || 0}%: ${commissionAmount.toLocaleString()} sats)`);
        } else {
          lines.push('Recibirás los BTC directamente en tu wallet.');
        }

        lines.push('', '⏱ Al pagar, 1-5 minutos.');

        await ctx.editMessageText(lines.join('\n'));

        // Start monitoring for settlement + forward (intermediary mode)
        if (walletReady && chatId && messageId) {
          monitorReverseSwapAndForward(
            swapId, swapServiceId, preimageHex,
            s.sourceAmount!, userReceives, s.destAddress,
            chatId, messageId, userState?.userId,
          ).catch((err) => {
            logger.error('Reverse swap monitor failed', { error: err, swapId, boltzId: swapServiceId });
          });
        } else if (!walletReady && boltzWebSocket) {
          // Direct mode: WebSocket updates DB + notifies user on terminal events
          boltzWebSocket.subscribe(swapServiceId, async (_id, status) => {
            logger.debug('Reverse swap WS status (direct)', { boltzId: swapServiceId, status });

            if (status === 'invoice.settled' || status === 'transaction.claimed') {
              await Swap.findOneAndUpdate(
                { swapId },
                { boltzStatus: status, status: 'completed', completedAt: new Date() },
              ).catch(() => {});
              if (userState?.userId && userState.userId !== 'unknown') {
                User.findOneAndUpdate(
                  { telegramId: userState.userId },
                  { $inc: { swapsCount: 1, totalVolume: s.sourceAmount || 0 } },
                ).catch(() => {});
              }
              if (chatId) {
                botInstance?.telegram.sendMessage(chatId,
                  '🎉 *¡Swap completado!*\n\n' +
                  `Swap: \`${swapId}\`\n` +
                  `Pagaste ${(s.sourceAmount || 0).toLocaleString()} sats por Lightning\n` +
                  `Recibiste ~${(res.expectedAmount || 0).toLocaleString()} sats en tu direccion.\n\n` +
                  'Usa /swap para un nuevo intercambio.',
                ).catch(() => {});
              }
              boltzWebSocket?.unsubscribe(swapServiceId);
            } else if (['invoice.expired', 'transaction.failed', 'swap.expired', 'transaction.refunded',
              'invoice.failedToPay', 'transaction.lockupFailed'].includes(status)) {
              await Swap.findOneAndUpdate(
                { swapId },
                { boltzStatus: status, status: 'failed' },
              ).catch(() => {});
              boltzWebSocket?.unsubscribe(swapServiceId);
              if (chatId) {
                botInstance?.telegram.sendMessage(chatId,
                  '❌ Swap #' + swapId + ' no se completo.\n\nEstado: ' + status + '\nContacta a soporte.',
                ).catch(() => {});
              }
            }
          });
          setTimeout(() => boltzWebSocket?.unsubscribe(swapServiceId), 35 * 60 * 1000);
        }
      } else {
        if (!s.invoice) { await ctx.editMessageText('Falta la invoice. Usa /swap.'); clearSs(ctx); return; }

        const walletReady = isWalletReady();
        const useIntermediary = walletReady;
        logger.info('Swap: ONCHAIN2LN mode selection', { walletReady, useIntermediary });

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

          const depositMsg = await ctx.reply(
            '🏦 *Deposita a nuestra wallet*\n\n' +
            'Envía **' + s.sourceAmount!.toLocaleString() + ' sats** a:\n\n' +
            '`' + ourAddress + '`\n\n' +
            'Al confirmarse el depósito, crearemos el swap\n' +
            'y pagaremos tu invoice Lightning de ' +
            (s.fee?.estimatedReceive?.toLocaleString() || '?') + ' sats.\n\n' +
            '⏱ Tiempo estimado: 10-60 minutos',
          );

          // Start background deposit monitoring on the reply message
          if (depositMsg.message_id) {
            monitorDepositAndSwap(swapId, s, depositMsg.chat.id, depositMsg.message_id, userState?.userId).catch((err) => {
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

          // Save address info for WS status updates
          s.boltzAddress = res.address;
          s.boltzExpectedAmount = res.expectedAmount;
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

          // Do NOT edit the callback message — reply with address in new visible message
          const addrMsg = await ctx.reply(
            '━━━━━━━━━━━━━━━━━━━━\n' +
            '✅ *INTERCAMBIO CREADO*\n' +
            '━━━━━━━━━━━━━━━━━━━━\n\n' +
            '📤 Envía exactamente **' + res.expectedAmount.toLocaleString() + ' sats** a:\n\n' +
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
// BTC → USDC / USDT swap execution (ChangeNOW)
// ============================================================
async function executeBTCStableSwap(
  ctx: Context, swapId: string, s: SwapSession,
  userId?: string, chatId?: number, messageId?: number,
): Promise<void> {
  const cnClient = getCNClient();
  if (!cnClient) {
    await ctx.editMessageText('Cambios BTC→stablecoin no configurados.');
    clearSs(ctx); return;
  }

  const destCurrency = s.direction === 'BTC2USDT' ? 'USDT' : 'USDC';
  const destNet = s.destChain || 'TRC-20';

  try {
    const destAsset = cnClient.getTicker(destCurrency as 'USDT' | 'USDC', destNet);
    if (!destAsset) { await ctx.editMessageText('Red de destino no soportada.'); clearSs(ctx); return; }

    const btcAsset = cnClient.getBTCDest();
    const fromAmount = (s.sourceAmount! / 100_000_000).toFixed(8); // sats → BTC

    logger.info('BTC→stablecoin: creating ChangeNOW exchange', {
      from: 'btc', to: `${destAsset.ticker}:${destAsset.network}`, fromAmount,
      destAddress: s.destAddress?.slice(0, 20) + '...',
    });

    const estimate = await cnClient.estimate(
      btcAsset.ticker, destAsset.ticker, fromAmount,
      btcAsset.network, destAsset.network,
    );

    const exchange = await cnClient.createExchange({
      fromCurrency: btcAsset.ticker, toCurrency: destAsset.ticker,
      fromNetwork: btcAsset.network, toNetwork: destAsset.network,
      fromAmount,
      toAmount: (estimate.toAmount || estimate.estimatedAmount || '0'),
      address: s.destAddress || 'required',
      flow: 'fixed-rate', rateId: estimate.rateId,
    });

    // Persist swap record
    const receivedCents = Math.floor(parseFloat(estimate.toAmount || estimate.estimatedAmount || '0') * 100);
    try {
      await Swap.create({
        swapId, userId: userId || 'unknown',
        direction: s.direction,
        sourceChain: 'BTC', destChain: s.destChain,
        sourceAmount: s.sourceAmount || 0,
        destAmount: receivedCents,
        sourceCurrency: 'BTC', destCurrency,
        boltzSwapId: exchange.id, boltzStatus: 'waiting',
        commissionRate: s.fee?.commissionRate || commissionEngine.getCommissionRate(),
        commissionAmount: s.fee?.commissionAmount || 0,
        botProfit: s.fee?.botProfit || 0,
        status: 'pending',
      });
    } catch (dbError) {
      logger.error('Failed to persist BTC→stablecoin swap', { error: dbError, swapId });
    }

    // Track earnings and raffle
    if (s.fee) {
      raffleEngine.trackSwapVolume(userId || 'unknown', s.sourceAmount!).catch(() => {});
      treasuryEngine.trackEarnings(s.fee.commissionAmount).catch(() => {});
    }

    clearSs(ctx);

    const lines = [
      '⏳ *Intercambio creado!*',
      '',
      `Swap ID: \`${swapId}\``,
      `Envía: **${fromAmount} BTC** a: `,
      '`' + exchange.payinAddress + '`',
      '',
      `Recibirás: ~${estimate.toAmount || estimate.estimatedAmount || '0'} ${destCurrency} (${destNet})`,
      '',
      '⏱ Tiempo estimado: 5-30 min',
    ];

    await ctx.editMessageText(lines.join('\n'));

    // Start polling for status updates
    if (chatId && messageId) {
      startCNPolling(exchange.id, swapId, chatId, messageId).catch((err) => {
        logger.error('CN polling failed for BTC→stablecoin', { error: err, cnId: exchange.id });
      });
    }
  } catch (error: any) {
    const status = error?.response?.status;
    const errMsg = status === 401
      ? '\n\n🔑 Error de API key.'
      : status === 404
      ? '\n\n🔍 Par de intercambio no disponible.'
      : '';
    logger.error('BTC→stablecoin swap failed', { error, swapId, status });
    await ctx.editMessageText('No se pudo crear el intercambio.' + errMsg + '\n\nIntenta de nuevo con /swap.');
    clearSs(ctx);
  }
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
    const maxPolls = 180; // 60 min at 20s intervals
    const ourAddress = getWalletAddress();
    const expectedAmount = s.sourceAmount || 0;
    const neededConfs = minConfirmations(expectedAmount);
    const swapCreatedAt = Date.now(); // track when this swap was created
    const processedTxids = new Set<string>(); // dedup: never reprocess same txid

    logger.info('Deposit monitor started', {
      swapId, ourAddress, expected: expectedAmount,
      minConfirmations: neededConfs, swapCreatedAt: new Date(swapCreatedAt).toISOString(),
    });

    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, 20_000));

      try {
        const url = `https://mempool.space/api/address/${ourAddress}/txs`;
        if (i % 3 === 0) {
          logger.debug('Deposit polling', { swapId, poll: i + 1, minConfs: neededConfs, processedCount: processedTxids.size });
        }
        const { data } = await axios.get<Array<{
          txid: string;
          vout: Array<{ scriptpubkey_address: string; value: number }>;
          status: { confirmed: boolean; block_height?: number; block_time?: number };
        }>>(url, { timeout: 10000 });

        // Get current tip height for confirmation counting
        const tipHeight = await getTipHeight();

        for (const tx of data) {
          // --- DEDUP: skip already-processed txids ---
          if (processedTxids.has(tx.txid)) continue;

          // --- DEDUP: skip txs confirmed before swap was created (>10 min tolerance) ---
          const txBlockTime = (tx.status.block_time || 0) * 1000; // Unix timestamp → ms
          const txAgeMs = swapCreatedAt - txBlockTime;
          // If tx was confirmed > 10 minutes before swap creation, it's not ours
          if (tx.status.confirmed && txBlockTime > 0 && txAgeMs > 10 * 60_000) {
            processedTxids.add(tx.txid); // mark as seen to avoid re-checking
            logger.debug('Deposit skip: tx too old', {
              txid: tx.txid, txAgeMin: Math.round(txAgeMs / 60000),
              txBlockTime: new Date(txBlockTime).toISOString(),
            });
            continue;
          }

          for (let vi = 0; vi < tx.vout.length; vi++) {
            const vout = tx.vout[vi];
            if (vout.scriptpubkey_address !== ourAddress) continue;

            const receivedSats = vout.value;
            const txBlockHeight = tx.status.block_height || 0;
            const confirmations = tx.status.confirmed && txBlockHeight > 0
              ? tipHeight - txBlockHeight + 1
              : 0;

            logger.debug('Deposit candidate', {
              txid: tx.txid, vout: vi, receivedSats, expectedAmount,
              confirmed: tx.status.confirmed, confirmations, needed: neededConfs,
              txAgeMin: Math.round(txAgeMs / 60000),
            });

              if (receivedSats >= expectedAmount && confirmations >= neededConfs) {
                processedTxids.add(tx.txid); // never re-process
                logger.info('Deposit fully confirmed for swap', {
                  swapId, txid: tx.txid, vout: vi, amount: receivedSats, confirmations,
                });

                // Deduct commission + raffle
                const commissionAmount = s.fee?.commissionAmount || 0;
                await treasuryEngine.trackEarnings(commissionAmount).catch(() => {});
                await raffleEngine.trackSwapVolume(userId || 'unknown', expectedAmount).catch(() => {});

                // === NOW create the Boltz swap AFTER confirmed deposit ===
                logger.info('Creating Boltz swap after confirmed deposit', { swapId, txid: tx.txid });
                const refundKeys = ECPair.makeRandom();
                try {
                  const res = await boltzClient.createSubmarineSwap({
                    from: 'BTC', to: 'BTC',
                    invoice: s.invoice!,
                    refundPublicKey: Buffer.from(refundKeys.publicKey).toString('hex'),
                  });

                  logger.info('Boltz swap created via intermediary', { swapId, boltzId: res.id });

                  // Auto-send BTC from our wallet to Boltz address
                  const sendResult = await sendToAddress(res.address, res.expectedAmount);

                  if (sendResult) {
                    // === SUCCESS PATH ===
                    await Swap.findOneAndUpdate(
                      { swapId },
                      { boltzSwapId: res.id, boltzStatus: 'invoice.set',
                        status: 'pending', completedAt: undefined },
                    ).catch(() => {});

                    const statusMsg =
                      '✅ Depósito confirmado: ' + formatSats(receivedSats) + '\n' +
                      `(${confirmations} confirmaciones)\n` +
                      `TX: \`${tx.txid.slice(0, 16)}...\`\n\n` +
                      '📤 Enviado: `' + sendResult + '`\n\n' +
                      'Swap: `' + res.id + '`\n' +
                      'Recibirás ' + (s.fee?.estimatedReceive?.toLocaleString() || '?') + ' sats en Lightning.\n\n' +
                      '⏳ _Esperando confirmación del pago..._';

                    await botInstance.telegram.editMessageText(chatId, messageId, undefined, statusMsg);

                    // Subscribe to WebSocket for Boltz updates
                    if (boltzWebSocket) {
                      boltzWebSocket.subscribe(res.id, (_id, status) => {
                        updateSwapMessage(chatId, messageId, status, swapId, s, res.id, userId).catch(() => {});
                      });
                      setTimeout(() => boltzWebSocket?.unsubscribe(res.id), 30 * 60 * 1000);
                    }

                    // === Fallback verification (DB-check, Boltz has no REST status endpoint) ===
                    startBoltzFallbackPoll(swapId, res.id, chatId, messageId, s, userId).catch((err) => {
                      logger.error('Boltz fallback poll failed', { error: err, swapId, boltzId: res.id });
                    });
                  } else {
                    // === SEND FAILURE: mark as failed in DB + notify admin ===
                    await Swap.findOneAndUpdate(
                      { swapId },
                      { boltzSwapId: res.id, boltzStatus: 'send_failed',
                        status: 'failed', completedAt: undefined },
                    ).catch(() => {});

                    const failMsg =
                      '✅ Depósito recibido: ' + formatSats(receivedSats) + '\n\n' +
                      '⚠️ *ERROR al procesar el swap.*\n\n' +
                      'Swap #' + swapId + '\n\n' +
                      'Contacta a soporte con este ID.';

                    await botInstance.telegram.editMessageText(chatId, messageId, undefined, failMsg);

                    await notifyAdmins(
                      '❌ *FALLO CRÍTICO: No se pudo enviar a Boltz*\n\n' +
                      `Swap: \`${swapId}\`\n` +
                      `Boltz ID: \`${res.id}\`\n` +
                      `TX depósito: \`${tx.txid}\`\n` +
                      `Depósito: ${receivedSats.toLocaleString()} sats\n` +
                      `Usuario: \`${userId || 'N/A'}\`\n` +
                      `Boltz address: \`${res.address}\`\n` +
                      `Expected: ${res.expectedAmount.toLocaleString()} sats`,
                    );
                  }
                } catch (boltzError: any) {
                  // === BOLTZ CREATE FAILURE ===
                  logger.error('Boltz swap creation failed after deposit', { error: boltzError, swapId, txid: tx.txid });

                  // Retry up to 3 more times with backoff (4 total including initial)
                  const maxRetries = 3;
                  let retryRes: { id: string; address: string; expectedAmount: number } | null = null;

                  for (let r = 1; r <= maxRetries; r++) {
                    const delayMs = r * 8000; // 8s, 16s, 24s
                    logger.warn('Retrying Boltz swap creation', { swapId, attempt: r, delayMs });
                    await new Promise((res) => setTimeout(res, delayMs));

                    try {
                      const retryKeys = ECPair.makeRandom();
                      retryRes = await boltzClient.createSubmarineSwap({
                        from: 'BTC', to: 'BTC',
                        invoice: s.invoice!,
                        refundPublicKey: Buffer.from(retryKeys.publicKey).toString('hex'),
                      });
                      logger.info('Boltz swap created on retry', { swapId, attempt: r, boltzId: retryRes.id });
                      break;
                    } catch (retryErr: any) {
                      logger.warn('Boltz retry failed', { swapId, attempt: r, error: retryErr?.message || String(retryErr) });
                    }
                  }

                  if (retryRes) {
                    // Retry succeeded — continue with swap
                    const sendResult = await sendToAddress(retryRes.address, retryRes.expectedAmount);
                    if (sendResult) {
                      await Swap.findOneAndUpdate(
                        { swapId },
                        { boltzSwapId: retryRes.id, boltzStatus: 'invoice.set', status: 'pending' },
                      ).catch(() => {});
                      const statusMsg = '✅ Depósito confirmado: ' + formatSats(receivedSats) + '\n' +
                        `(${confirmations} confirmaciones)\nTX: \`${tx.txid.slice(0, 16)}...\`\n\n` +
                        '📤 Enviado (reintento): `' + sendResult + '`\n\n' +
                        'Swap: `' + retryRes.id + '`\n' +
                        'Recibirás ' + (s.fee?.estimatedReceive?.toLocaleString() || '?') + ' sats en Lightning.\n\n' +
                        '⏳ _Esperando confirmación del pago..._';
                      await botInstance.telegram.editMessageText(chatId, messageId, undefined, statusMsg);
                      if (boltzWebSocket) {
                        boltzWebSocket.subscribe(retryRes.id, (_id, wsStatus) => {
                          updateSwapMessage(chatId, messageId, wsStatus, swapId, s, retryRes!.id, userId).catch(() => {});
                        });
                        setTimeout(() => boltzWebSocket?.unsubscribe(retryRes!.id), 30 * 60 * 1000);
                      }
                      startBoltzFallbackPoll(swapId, retryRes.id, chatId, messageId, s, userId).catch((err) => {
                        logger.error('Boltz fallback poll failed', { error: err, swapId, boltzId: retryRes!.id });
                      });
                    } else {
                      // Send failed even after retry
                      await Swap.findOneAndUpdate({ swapId }, { boltzStatus: 'send_failed', status: 'failed' }).catch(() => {});
                      await botInstance.telegram.editMessageText(chatId, messageId, undefined,
                        '✅ Depósito recibido: ' + formatSats(receivedSats) + '\n\n' +
                        '⚠️ *ERROR al enviar a Boltz tras reintentos.*\n\nSwap #' + swapId + '\nContacta a soporte.',
                      ).catch(() => {});
                      await notifyAdmins('❌ *FALLO CRÍTICO tras retry: No se pudo enviar a Boltz*\n\n' +
                        `Swap: \`${swapId}\`\nBoltz: \`${retryRes.id}\`\nDepósito: ${receivedSats.toLocaleString()} sats`);
                    }
                  } else {
                    // All retries failed — AUTO-REFUND the user
                    logger.error('All Boltz retries exhausted, initiating auto-refund', { swapId });

                    await Swap.findOneAndUpdate(
                      { swapId },
                      { boltzStatus: 'boltz_create_failed', status: 'refunded' },
                    ).catch(() => {});

                    // Try to refund to sender address
                    let refunded = false;
                    try {
                      const { data: txData } = await axios.get<{
                        vin: Array<{ prevout: { scriptpubkey_address: string } }>;
                      }>(`https://mempool.space/api/tx/${tx.txid}`, { timeout: 10000 });
                      const senderAddr = txData.vin[0]?.prevout?.scriptpubkey_address;
                      if (senderAddr) {
                        const refundResult = await sendToAddress(senderAddr, receivedSats);
                        if (refundResult) {
                          refunded = true;
                          logger.info('Auto-refund successful', { swapId, txid: refundResult, to: senderAddr, amount: receivedSats });
                          await botInstance.telegram.editMessageText(chatId, messageId, undefined,
                            '⚠️ Swap #' + swapId + ' no se pudo crear (timeout Boltz).\n\n' +
                            '✅ *Reembolso automático:* ' + formatSats(receivedSats) + '\n' +
                            'TX: `' + refundResult + '`\n\nUsa /swap para intentar de nuevo.',
                          ).catch(() => {});
                        }
                      }
                    } catch { /* refund failed, notify admin */ }

                    if (!refunded) {
                      await notifyAdmins(
                        '❌ *FALLO: Swap no creado + reembolso automático falló*\n\n' +
                        `Swap: \`${swapId}\`\n` +
                        `Depósito: ${receivedSats.toLocaleString()} sats\n` +
                        `TX: \`${tx.txid}\`\n` +
                        `Usuario: \`${userId || 'N/A'}\`\n\n` +
                        '**ACCIÓN REQUERIDA**: Reembolsar manualmente.',
                      );
                      await botInstance.telegram.editMessageText(chatId, messageId, undefined,
                        '✅ Depósito recibido: ' + formatSats(receivedSats) + '\n\n' +
                        '⚠️ Error al crear el swap (timeout).\n\n' +
                        'Swap #' + swapId + '\n' +
                        'Se notificó a soporte para reembolso manual.',
                      ).catch(() => {});
                    }
                  }
                }

                return;
              }

              // Only mark CONFIRMED txids as seen — unconfirmed may confirm later
              if (tx.status.confirmed) {
                processedTxids.add(tx.txid);
              }
            }
          }

        if (i % 3 === 0) {
          logger.debug('Still waiting for intermediary deposit', { swapId, poll: i + 1 });
        }
      } catch (err) {
        logger.warn('Deposit poll error', { swapId, error: String(err), poll: i + 1 });
        // polling error, continue
      }
    }

    // === TIMEOUT: notify admin ===
    logger.warn('Deposit monitor TIMEOUT', { swapId, expectedAmount, maxPolls });

    await botInstance.telegram.editMessageText(chatId, messageId, undefined,
      '⏰ Tiempo de espera agotado para el swap #' + swapId + '.\n\n' +
      'Si realizaste el depósito, contacta a soporte.',
    ).catch(() => {});

    await notifyAdmins(
      '⏰ *Timeout de depósito*\n\n' +
      `Swap: \`${swapId}\`\n` +
      `Usuario: \`${userId || 'N/A'}\`\n` +
      `Monto esperado: ${expectedAmount.toLocaleString()} sats\n` +
      `Wallet: \`${ourAddress}\`\n` +
      `Tiempo: 60 minutos sin detectar depósito confirmado.`,
    );
  } catch (error) {
    logger.error('Intermediary monitor failed', { error, swapId });
  }
}

// ============================================================
// Fallback verification: confirm swap completed via DB + mempool
// Boltz API v2 has NO REST status endpoint; rely on WebSocket → DB updates.
// ============================================================
async function startBoltzFallbackPoll(
  swapId: string, boltzId: string, chatId: number, messageId: number,
  session: SwapSession, userId?: string,
): Promise<void> {
  // Wait 5 min before starting (let WebSocket handle normal completion)
  await new Promise((r) => setTimeout(r, 5 * 60_000));

  logger.info('Boltz fallback started (DB-based)', { swapId, boltzId });
  const maxPolls = 60; // 30 min at 30s intervals

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, 30_000));

    try {
      // Check MongoDB — WebSocket handler updates swap status on terminal events
      const dbSwap = await Swap.findOne({ swapId }).lean();
      const dbState = dbSwap?.status;

      if (dbState === 'completed') {
        logger.info('Boltz fallback: swap completed via WS', { swapId, boltzId });
        return;
      }

      if (dbState === 'failed') {
        logger.info('Boltz fallback: swap failed', { swapId, boltzId });
        return;
      }

      if (dbState === 'refunded') {
        logger.info('Boltz fallback: swap refunded', { swapId, boltzId });
        return;
      }

      // Halfway through fallback (~20 min after swap creation)
      if (i === 30) {
        logger.warn('Boltz fallback: still pending after 20+ min', { swapId, boltzId, dbState });
      }
    } catch (err) {
      logger.warn('Boltz fallback DB check error', { swapId, boltzId, error: String(err) });
    }
  }

  // Full fallback window (~35 min) elapsed without terminal state
  logger.warn('Boltz fallback: swap not resolved after full window', { swapId, boltzId });
  await notifyAdmins(
    '⚠️ *Swap posiblemente atascado*\n\n' +
    `Swap: \`${swapId}\`\n` +
    `Boltz: \`${boltzId}\`\n` +
    `Usuario: \`${userId || 'N/A'}\`\n` +
    `Monto: ${session.sourceAmount?.toLocaleString() || '?'} sats\n` +
    'No se detectó completion/fallo tras ~35 min. Revisar manualmente.',
  );
}

// ============================================================
// Reverse swap (LN→BTC) monitor + forward
// ============================================================
async function monitorReverseSwapAndForward(
  swapId: string, boltzId: string, preimageHex: string,
  invoiceAmount: number, userReceives: number, destAddress: string,
  chatId: number, messageId: number, userId?: string,
): Promise<void> {
  if (!botInstance) return;

  logger.info('Reverse swap monitor started (WebSocket)', { swapId, boltzId, invoiceAmount, userReceives, dest: destAddress.slice(0, 12) + '...' });

  return new Promise<void>((resolve) => {
    let settled = false;
    let resolved = false;
    const timeoutMs = 60 * 60_000; // 60 min max

    const resolveOnce = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        boltzWebSocket?.unsubscribe(boltzId);
        resolve();
      }
    };

    const timeoutId = setTimeout(() => {
      logger.warn('Reverse swap monitor TIMEOUT (WebSocket)', { swapId, boltzId });
      notifyAdmins(
        '⏰ *Reverse swap timeout*\n\n' +
        `Swap: \`${swapId}\` | Boltz: \`${boltzId}\`\n` +
        'No se detectó settlement en 60 min.',
      );
      resolveOnce();
    }, timeoutMs);

    if (!boltzWebSocket) {
      logger.error('No WebSocket available for reverse swap monitoring', { swapId, boltzId });
      notifyAdmins('❌ *WebSocket no disponible*\n\nSwap: `' + swapId + '`\nBoltz: `' + boltzId + '`');
      resolveOnce();
      return;
    }

    // --- Subscribe to WebSocket for Boltz swap status updates ---
    boltzWebSocket.subscribe(boltzId, async (_id: string, status: BoltzSwapStatus) => {
      if (resolved) return;
      logger.debug('Reverse swap WS update', { boltzId, status });

      // Forward non-terminal statuses to user message (if it's a new visible status)
      const visibleStatuses = ['swap.created', 'invoice.set', 'transaction.mempool', 'transaction.confirmed',
        'invoice.pending', 'invoice.paid', 'transaction.claim.pending'];
      if (visibleStatuses.includes(status)) {
        const labels: Record<string, string> = {
          'swap.created': '⏳ Swap creado. Pagando invoice Lightning...',
          'invoice.set': '📋 Pagando invoice...',
          'transaction.mempool': '🔍 Transacción detectada en la red...',
          'transaction.confirmed': '✅ Transacción confirmada. Procesando...',
          'invoice.pending': '⚡ Pagando invoice Lightning...',
          'invoice.paid': '💰 Invoice pagada. Completando swap...',
          'transaction.claim.pending': '🔐 Finalizando swap...',
        };
        const label = labels[status] || ('Estado: ' + status);
        await botInstance!.telegram.editMessageText(chatId, messageId, undefined,
          '⚡ *Intercambio en curso*\n\n' +
          `Swap: \`${swapId}\`\n` +
          `Pagaste ${invoiceAmount.toLocaleString()} sats\n\n` +
          label,
        ).catch(() => {});
        return;
      }

      // --- Terminal statuses ---
      if (status === 'invoice.settled' || status === 'transaction.claimed') {
        if (settled) return; // already handled
        settled = true;
        logger.info('Reverse swap SETTLED (WebSocket)', { swapId, boltzId, status });

        await botInstance!.telegram.editMessageText(chatId, messageId, undefined,
          '✅ Invoice pagada. Esperando confirmación on-chain...',
        ).catch(() => {});

        // --- Step 2: Wait for BTC to arrive at our wallet (mempool.space polling) ---
        const ourAddress = getWalletAddress();
        const depositPolls = 90; // 30 min at 20s intervals
        let forwarded = false;

        for (let j = 0; j < depositPolls; j++) {
          if (resolved) return;
          await new Promise((r) => setTimeout(r, 20_000));

          try {
            const url = `https://mempool.space/api/address/${ourAddress}/txs`;
            const { data } = await axios.get<Array<{
              txid: string;
              vout: Array<{ scriptpubkey_address: string; value: number }>;
              status: { confirmed: boolean; block_height?: number };
            }>>(url, { timeout: 10000 });

            for (const tx of data) {
              if (!tx.status.confirmed) continue;
              for (const vout of tx.vout) {
                if (vout.scriptpubkey_address !== ourAddress) continue;
                const receivedSats = vout.value;

                // Match: received sats + fee buffer = invoice amount
                // Boltz may deduct a small miner fee, so check >= userReceives
                if (receivedSats >= userReceives) {
                  logger.info('Reverse swap: BTC detected at wallet', { swapId, txid: tx.txid, receivedSats });

                  // Forward BTC to user
                  const sendResult = await sendToAddress(destAddress, userReceives);

                  if (sendResult) {
                    await Swap.findOneAndUpdate(
                      { swapId },
                      { boltzStatus: 'invoice.settled', status: 'completed', completedAt: new Date() },
                    ).catch(() => {});

                    const commissionAmount = invoiceAmount - userReceives;
                    treasuryEngine.trackEarnings(commissionAmount).catch(() => {});
                    raffleEngine.trackSwapVolume(userId || 'unknown', invoiceAmount).catch(() => {});
                    if (userId && userId !== 'unknown') {
                      User.findOneAndUpdate(
                        { telegramId: userId },
                        { $inc: { swapsCount: 1, totalVolume: invoiceAmount } },
                      ).catch(() => {});
                    }

                    await botInstance!.telegram.editMessageText(chatId, messageId, undefined,
                      '🎉 *¡Swap completado!*\n\n' +
                      `Swap: \`${swapId}\`\n` +
                      `Pagaste ${invoiceAmount.toLocaleString()} sats por Lightning\n` +
                      `Recibiste ${userReceives.toLocaleString()} sats en \`${destAddress.slice(0, 12)}...\`\n` +
                      `TX: \`${sendResult}\`\n\n` +
                      'Usa /swap para un nuevo intercambio.',
                    ).catch(() => {});
                  } else {
                    await Swap.findOneAndUpdate(
                      { swapId },
                      { boltzStatus: 'forward_failed', status: 'failed' },
                    ).catch(() => {});
                    await botInstance!.telegram.editMessageText(chatId, messageId, undefined,
                      '⚠️ BTC recibidos pero error al enviar a tu dirección.\n\n' +
                      'Swap #' + swapId + '\nContacta a soporte.',
                    ).catch(() => {});
                    await notifyAdmins(
                      '❌ *Forward falló en reverse swap*\n\n' +
                      `Swap: \`${swapId}\` | Boltz: \`${boltzId}\`\n` +
                      `User: \`${userId || 'N/A'}\`\n` +
                      `Dest: \`${destAddress}\`\n` +
                      `Amount: ${userReceives.toLocaleString()} sats`,
                    );
                  }
                  forwarded = true;
                  break;
                } // end amount check
              } // end vout loop
              if (forwarded) break;
            } // end tx loop
            if (forwarded) break;
          } catch (err) {
            logger.warn('Reverse swap BTC poll error', { swapId, error: String(err), poll: j + 1 });
          }
        } // end deposit polls

        if (!forwarded) {
          logger.warn('Reverse swap: BTC never arrived at wallet', { swapId, boltzId });
          await Swap.findOneAndUpdate({ swapId }, { boltzStatus: 'btc_not_received', status: 'failed' }).catch(() => {});
          await notifyAdmins(
            '⚠️ *Reverse swap: BTC no detectado*\n\n' +
            `Swap: \`${swapId}\` | Boltz: \`${boltzId}\`\n` +
            `Invoice pagada pero no se detectó BTC en wallet tras 30 min.`,
          );
          await botInstance!.telegram.editMessageText(chatId, messageId, undefined,
            '⚠️ Invoice pagada pero los BTC no se detectaron en wallet.\n\n' +
            'Swap #' + swapId + '\nContacta a soporte.',
          ).catch(() => {});
        }

        resolveOnce();
        return;
      } // end settled

      // --- Other terminal (failure) statuses ---
      const failureStatuses = ['invoice.expired', 'transaction.failed', 'swap.expired', 'transaction.refunded',
        'invoice.failedToPay', 'transaction.lockupFailed'];
      if (failureStatuses.includes(status)) {
        logger.warn('Reverse swap FAILED (WebSocket)', { swapId, boltzId, status });
        await Swap.findOneAndUpdate({ swapId }, { boltzStatus: status, status: 'failed' }).catch(() => {});
        await botInstance!.telegram.editMessageText(chatId, messageId, undefined,
          '❌ Swap #' + swapId + ' no se completó.\n\n' +
          'Estado: ' + status + '\nContacta a soporte.',
        ).catch(() => {});
        await notifyAdmins(
          '❌ *Reverse swap falló*\n\n' +
          `Swap: \`${swapId}\` | Boltz: \`${boltzId}\`\n` +
          `Estado: ${status}\nUsuario: \`${userId || 'N/A'}\``,
        );
        resolveOnce();
        return;
      }
    });
  });
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
    'transaction.confirmed': '✅ Transacción confirmada. Pagando tu invoice Lightning...',
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
    // Build message: address + status (address persists, status updates)
    let text = '🔁 Intercambio: `' + swapId + '`\n\n';

    if (session.boltzAddress) {
      text += '📤 Envía **' + (session.boltzExpectedAmount || session.sourceAmount || 0).toLocaleString() + ' sats** a:\n';
      text += '`' + session.boltzAddress + '`\n\n';
    }

    text += msg;

    await botInstance.telegram.editMessageText(chatId, messageId, undefined, text);

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
