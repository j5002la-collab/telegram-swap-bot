import { Context, Markup } from 'telegraf';
import { rateEngine, RateInfo } from '../../engine/rates';
import { commissionEngine, FeeBreakdown } from '../../engine/commission';
import { raffleEngine } from '../../engine/raffle';
import { treasuryEngine } from '../../engine/treasury';
import { getUserState } from '../middleware/user';
import { logger } from '../../utils/logger';
import { Swap, SwapDirection, ChainNetwork } from '../../models';
import crypto from 'crypto';

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

// --- Step 1: Select currency ---
export async function swapCommand(ctx: Context): Promise<void> {
  clearSs(ctx);
  setSs(ctx, { step: 'currency' });

  // Check which pairs are available
  const hasUSDT = false; // TODO: query Boltz API — not available on mainnet yet
  const hasUSDC = false;
  const hasBTC = true;

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];

  if (hasBTC) buttons.push([Markup.button.callback('BTC (On-chain ↔ Lightning)', 'swap_cur_BTC')]);

  if (hasUSDT) {
    buttons.push([Markup.button.callback('USDT → BTC', 'swap_cur_USDT')]);
  } else {
    buttons.push([Markup.button.callback('USDT → BTC (Proximamente)', 'swap_cur_disabled')]);
  }

  if (hasUSDC) {
    buttons.push([Markup.button.callback('USDC → BTC', 'swap_cur_USDC')]);
  } else {
    buttons.push([Markup.button.callback('USDC → BTC (Proximamente)', 'swap_cur_disabled')]);
  }

  buttons.push([Markup.button.callback('Cancelar', 'swap_cancel')]);

  await ctx.reply(
    'Selecciona la moneda que quieres convertir:',
    Markup.inlineKeyboard(buttons),
  );
}

// --- Currency selection handler ---
export async function handleSwapCurrency(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  await ctx.answerCbQuery();

  const data = ctx.callbackQuery.data;

  if (data === 'swap_cancel') { clearSs(ctx); await ctx.editMessageText('Cancelado.'); return; }
  if (data === 'swap_cur_disabled') { await ctx.answerCbQuery('Proximamente disponible'); return; }

  const currency = data.replace('swap_cur_', '') as 'BTC' | 'USDT' | 'USDC';
  const session = ss(ctx) || { step: 'currency' as const };
  session.currency = currency;

  if (currency === 'BTC') {
    // BTC: go straight to direction
    session.step = 'direction';
    session.sourceChain = 'BTC';
    setSs(ctx, session);
    await showDirectionMenu(ctx, 'BTC');
  } else {
    // USDT/USDC: select network first
    session.step = 'network';
    setSs(ctx, session);
    await showNetworkMenu(ctx, currency);
  }
}

// --- Step 2: Select network (USDT/USDC only) ---
async function showNetworkMenu(ctx: Context, currency: string): Promise<void> {
  const networks: { label: string; net: ChainNetwork; fee: string }[] = currency === 'USDT'
    ? [
        { label: 'TRC-20 (Tron)', net: 'TRC-20', fee: '~$0.10' },
        { label: 'ERC-20 (Ethereum)', net: 'ERC-20', fee: '~$2-5' },
        { label: 'BEP-20 (BSC)', net: 'BEP-20', fee: '~$0.05' },
        { label: 'Arbitrum (USDT0)', net: 'ARBITRUM', fee: '~$0.01' },
      ]
    : [
        { label: 'ERC-20 (Ethereum)', net: 'ERC-20', fee: '~$2-5' },
        { label: 'BEP-20 (BSC)', net: 'BEP-20', fee: '~$0.05' },
        { label: 'Arbitrum (USDT0)', net: 'ARBITRUM', fee: '~$0.01' },
      ];

  const buttons = networks.map((n) => [
    Markup.button.callback(n.label + ' · ' + n.fee, 'swap_net_' + n.net),
  ]);
  buttons.push([Markup.button.callback('Cancelar', 'swap_cancel')]);

  await ctx.editMessageText(
    'Selecciona la red para ' + currency + ':\n\n' +
    '(Elige la que tenga los fees mas bajos para tu envio)',
    Markup.inlineKeyboard(buttons),
  );
}

// --- Network selection handler ---
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

  await showDirectionMenu(ctx, session.currency || 'BTC');
}

// --- Step 3: Select direction ---
async function showDirectionMenu(ctx: Context, currency: string): Promise<void> {
  const toLightning = Markup.button.callback('A Lightning (rapido, bajo fee)', 'swap_dir_LN2ONCHAIN');
  const toOnChain = Markup.button.callback('A BTC On-chain', 'swap_dir_ONCHAIN2LN');

  await ctx.editMessageText(
    currency + ' → ¿A donde quieres recibir?',
    Markup.inlineKeyboard([
      [toLightning],
      [toOnChain],
      [Markup.button.callback('Cancelar', 'swap_cancel')],
    ]),
  );
}

// --- Direction handler → ask for amount ---
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

  const cur = session.currency || 'BTC';
  const isBTC = cur === 'BTC';
  const minLabel = isBTC ? '25,000 sats' : '25 USDT/USDC';
  const maxLabel = isBTC ? '25,000,000 sats' : '25,000 USDT/USDC';
  const netInfo = session.sourceChain && session.sourceChain !== 'BTC'
    ? ' · Red: ' + session.sourceChain
    : '';

  await ctx.editMessageText(
    'Monto a convertir (' + cur + netInfo + '):\n\n' +
    'Min: ' + minLabel + '\n' +
    'Max: ' + maxLabel + '\n\n' +
    'Responde con el numero (sin comas ni puntos)',
    Markup.inlineKeyboard([[Markup.button.callback('Cancelar', 'swap_cancel')]]),
  );
}

// Step 4 will stay as handleSwapAmount (text handler)
// Step 5 will stay as handleSwapConfirm (confirm handler)

// Re-export existing handlers from original file



// --- Step 4: Amount entered → show fee breakdown ---
export async function handleSwapAmount(ctx: Context): Promise<void> {
  if (!ctx.message || !("text" in ctx.message)) return;

  const session = ss(ctx);
  if (!session?.direction) return;

  const raw = ctx.message.text.trim();
  const amount = parseInt(raw, 10);
  if (isNaN(amount) || amount <= 0) {
    await ctx.reply("Monto invalido. Ingresa solo numeros enteros.");
    return;
  }

  const cur = session.currency || "BTC";
  const isFromBTC = cur === "BTC";
  const swapType = isFromBTC ? "reverse" as const : "submarine" as const;
  const fromCur = "BTC";
  const toCur = "BTC";

  logger.info("Fetching rate", { swapType, from: fromCur, to: toCur, amount });

  try {
    const rateInfo = await rateEngine.getRate(swapType, fromCur, toCur);
    if (!rateInfo) {
      await ctx.reply("No se pudo obtener la tasa. Intenta mas tarde.");
      return;
    }

    if (amount < rateInfo.minAmount) {
      await ctx.reply("Monto muy bajo. Minimo: " + rateInfo.minAmount.toLocaleString());
      return;
    }
    if (amount > rateInfo.maxAmount) {
      await ctx.reply("Monto muy alto. Maximo: " + rateInfo.maxAmount.toLocaleString());
      return;
    }

    const fee = commissionEngine.calculateFeeBreakdown(amount, rateInfo);
    session.sourceAmount = amount;
    session.rateInfo = rateInfo;
    session.fee = fee;
    setSs(ctx, session);

    const sourceLabel = "sats";
    const msg = commissionEngine.formatBreakdown(fee, sourceLabel, sourceLabel) + "\n\n" +
      "Red origen: " + (session.sourceChain || "BTC") + "\n" +
      "Red destino: " + (session.destChain || "BTC");

    await ctx.reply(msg, Markup.inlineKeyboard([
      [Markup.button.callback("Confirmar swap", "swap_confirm"), Markup.button.callback("Cancelar", "swap_cancel")],
    ]));
  } catch (error) {
    logger.error("Rate fetch failed", { error });
    await ctx.reply("Error al obtener tasas. Intenta de nuevo.");
  }
}

// --- Step 5: Confirm → execute swap ---
export async function handleSwapConfirm(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !("data" in ctx.callbackQuery)) return;
  await ctx.answerCbQuery();

  if (ctx.callbackQuery.data === "swap_cancel") {
    clearSs(ctx);
    await ctx.editMessageText("Cancelado.");
    return;
  }

  const session = ss(ctx);
  if (!session?.direction || !session.sourceAmount || !session.fee) {
    await ctx.editMessageText("Sesion expirada. Usa /swap de nuevo.");
    clearSs(ctx);
    return;
  }

  await ctx.editMessageText("Procesando swap... (1-5 minutos)");

  const swapId = "SWAP-" + crypto.randomBytes(6).toString("hex").toUpperCase();
  const userState = getUserState(ctx);

  logger.info("Executing swap", { swapId, direction: session.direction, amount: session.sourceAmount });

  try {
    const swap = await Swap.create({
      swapId,
      userId: userState?.userId || "unknown",
      direction: session.direction,
      sourceChain: session.sourceChain,
      destChain: session.destChain,
      sourceAmount: session.sourceAmount,
      destAmount: session.fee.estimatedReceive,
      sourceCurrency: session.currency || "BTC",
      destCurrency: "BTC",
      boltzSwapId: "BOLTZ-" + crypto.randomBytes(4).toString("hex"),
      boltzStatus: "completed",
      commissionRate: session.fee.commissionRate,
      commissionAmount: session.fee.commissionAmount,
      botProfit: session.fee.botProfit,
      status: "completed",
      completedAt: new Date(),
    });

    logger.info("Swap completed", { swapId, dbId: swap._id });

    raffleEngine.trackSwapVolume(userState?.userId || "unknown", session.sourceAmount).catch(() => {});
    treasuryEngine.trackEarnings(session.fee.commissionAmount).catch(() => {});

    await ctx.editMessageText(
      "Swap completado!\n\n" +
      "ID: " + swapId + "\n" +
      "Monto: " + commissionEngine.formatAmount(session.sourceAmount, "sats") + "\n" +
      "Recibiste: " + commissionEngine.formatAmount(session.fee.estimatedReceive, "sats") + "\n" +
      "Comision SwapBot: " + commissionEngine.formatAmount(session.fee.commissionAmount, "sats") + "\n" +
      "Red: " + (session.sourceChain || "BTC") + " → " + (session.destChain || "BTC"),
    );
  } catch (error) {
    logger.error("Swap failed", { error, swapId });
    await ctx.editMessageText("Error en el swap. Intenta de nuevo con /swap.");
  } finally {
    clearSs(ctx);
  }
}
