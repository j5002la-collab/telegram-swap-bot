/**
 * Reverse Swap Recovery Module
 *
 * Recovers stuck BTC from Boltz reverse swaps (LN → On-chain) that were
 * never claimed because `address` wasn't passed to createReverseSwap.
 *
 * Uses boltz-core v4 for:
 * - Swap tree reconstruction
 * - Taproot script-path claim transaction construction + signing
 * - mempool.space for UTXOs + broadcast
 */

import {
  constructClaimTransaction,
  reverseSwapTree,
  TaprootUtils,
  Musig,
  OutputType,
  Types,
} from 'boltz-core';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { Swap } from '../models';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';
import * as bitcoin from 'bitcoinjs-lib';
import axios from 'axios';
import crypto from 'crypto';

const ECPair = ECPairFactory(ecc);

// ── Hex helpers ──────────────────────────────────────────────────

const hexDecode = (s: string): Uint8Array => {
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(s.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};
const hexEncode = (b: Uint8Array | Buffer): string => Buffer.from(b).toString('hex');

// ── Mempoool.space ───────────────────────────────────────────────

interface MempoolUtxo {
  txid: string; vout: number; value: number;
  status: { confirmed: boolean; block_height?: number };
}

async function fetchUtxos(address: string): Promise<MempoolUtxo[]> {
  const { data } = await axios.get<MempoolUtxo[]>(
    `https://mempool.space/api/address/${address}/utxo`, { timeout: 10000 },
  );
  return data.filter((u) => u.status.confirmed);
}

async function getFeeRate(fallback = 2): Promise<number> {
  try {
    const { data } = await axios.get<{ halfHourFee: number; economyFee: number; fastestFee: number }>(
      'https://mempool.space/api/v1/fees/recommended', { timeout: 5000 },
    );
    const rate = data.halfHourFee || data.economyFee || data.fastestFee || fallback;
    return Math.max(rate, 2);
  } catch { return fallback; }
}

async function broadcastTx(txHex: string): Promise<string> {
  const { data } = await axios.post<string>('https://mempool.space/api/tx', txHex, {
    headers: { 'Content-Type': 'text/plain' }, timeout: 15000,
  });
  return data;
}

async function getOutputScript(txid: string, vout: number): Promise<Uint8Array> {
  const { data } = await axios.get<{ vout: Array<{ scriptpubkey: string }> }>(
    `https://mempool.space/api/tx/${txid}`, { timeout: 10000 },
  );
  return hexDecode(data.vout[vout].scriptpubkey);
}

// ── Key helpers ──────────────────────────────────────────────────

function getPrivateKeyBytes(wif: string): Uint8Array {
  const keyPair = ECPair.fromWIF(wif);
  return new Uint8Array(keyPair.privateKey!);
}

function getClaimPublicKeyBytes(wif: string): Uint8Array {
  const keyPair = ECPair.fromWIF(wif);
  return new Uint8Array(keyPair.publicKey);
}

/** Convert a BTC address (base58/bech32) to output script bytes */
function addressToScript(address: string): Uint8Array {
  return bitcoin.address.toOutputScript(address, bitcoin.networks.bitcoin);
}

// ── Types ────────────────────────────────────────────────────────

export interface RecoveryResult {
  success: boolean;
  txid?: string;
  error?: string;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Recover a swap from its database ID.
 * Requires recovery data saved at swap creation time.
 */
export async function recoverSwapByDbId(swapId: string): Promise<RecoveryResult> {
  try {
    const swap = await Swap.findOne({ swapId }).lean();
    if (!swap) return { success: false, error: `Swap ${swapId} not found` };
    return await recoverSwap(swap as any);
  } catch (err: any) {
    logger.error('Recovery failed', { swapId, error: err.message });
    return { success: false, error: err.message };
  }
}

async function recoverSwap(s: any): Promise<RecoveryResult> {
  if (s.direction !== 'LN2ONCHAIN') return { success: false, error: 'Not LN2ONCHAIN' };
  if (!s.preimage) return { success: false, error: 'No preimage' };
  if (!s.lockupAddress || !s.swapTree || !s.refundPublicKey || !s.timeoutBlockHeight) {
    return { success: false, error: 'Missing recovery data' };
  }
  if (!s.destAddress) return { success: false, error: 'No dest address' };
  if (!config.btcPrivateKeyWif) return { success: false, error: 'No wallet key' };

  try {
    const txHex = await buildClaimTx({
      lockupAddress: s.lockupAddress,
      preimageHex: s.preimage,
      claimPublicKeyBytes: getClaimPublicKeyBytes(config.btcPrivateKeyWif),
      refundPublicKeyHex: s.refundPublicKey,
      timeoutBlockHeight: s.timeoutBlockHeight,
      destAddress: s.destAddress,
      privateKeyWif: config.btcPrivateKeyWif,
    });

    logger.info('Recovery: broadcasting', { swapId: s.swapId });
    const txid = await broadcastTx(txHex);

    await Swap.findOneAndUpdate(
      { swapId: s.swapId },
      { status: 'completed', boltzStatus: 'recovered', completedAt: new Date() },
    );

    logger.info('Recovery: OK', { swapId: s.swapId, txid });
    return { success: true, txid };
  } catch (err: any) {
    logger.error('Recovery broadcast failed', { swapId: s.swapId, error: err.message });
    return { success: false, error: err.message };
  }
}

interface BuildClaimParams {
  lockupAddress: string;
  preimageHex: string;
  claimPublicKeyBytes: Uint8Array;
  refundPublicKeyHex: string;
  timeoutBlockHeight: number;
  destAddress: string;
  privateKeyWif: string;
}

async function buildClaimTx(p: BuildClaimParams): Promise<string> {
  // 1. Preimage hash (bytes)
  const preimageHash = new Uint8Array(
    crypto.createHash('sha256').update(Buffer.from(p.preimageHex, 'hex')).digest(),
  );
  const refundPubKey = hexDecode(p.refundPublicKeyHex);

  // 2. Reconstruct swap tree (all Uint8Array args)
  const swapTree = reverseSwapTree(
    false,
    preimageHash,
    p.claimPublicKeyBytes,
    refundPubKey,
    p.timeoutBlockHeight,
  );

  logger.info('Recovery: swap tree done', {
    tree: typeof swapTree.tree, claimLeafVer: (swapTree as any).claimLeaf?.version,
  });

  // 3. Taproot internal key = Musig2([claim, refund], tweak=treeRoot)
  const treeHash = TaprootUtils.taprootHashTree(swapTree.tree);
  const internalKey = Musig.aggregateKeys(
    [p.claimPublicKeyBytes, hexDecode(p.refundPublicKeyHex)],
    treeHash.hash as Uint8Array, // Merkle root hash (single tweak, not array)
  );

  logger.debug('Recovery: internal key', { ik: hexEncode(internalKey).substring(0, 16) + '...' });

  // 4. UTXOs at lockup address
  const utxos = await fetchUtxos(p.lockupAddress);
  if (utxos.length === 0) throw new Error(`No UTXOs at ${p.lockupAddress}`);

  const totalSats = utxos.reduce((sum, u) => sum + u.value, 0);
  logger.info('Recovery: utxos found', { count: utxos.length, sats: totalSats });

  // 5. Fee estimate
  const feeRate = await getFeeRate();
  const fee = BigInt(Math.max(utxos.length * 110 * feeRate + 500, 1000));

  // 6. Build ClaimDetails[]
  const privKeyBytes = getPrivateKeyBytes(p.privateKeyWif);
  const preimageBytes = hexDecode(p.preimageHex);
  const destScript = addressToScript(p.destAddress);

  const claimDetails: any[] = [];
  for (const u of utxos) {
    const script = await getOutputScript(u.txid, u.vout);
    claimDetails.push({
      transactionId: u.txid,
      vout: u.vout,
      amount: BigInt(u.value),
      type: OutputType.Taproot,
      cooperative: false,
      swapTree,
      internalKey,
      privateKey: privKeyBytes,
      preimage: preimageBytes,
      script,
    });
  }

  // 7. Build + sign claim tx
  const tx = constructClaimTransaction(
    claimDetails, destScript, fee, true, p.timeoutBlockHeight, false,
  );

  const txHex = (tx as any).hex;
  logger.info('Recovery: tx built', { fee: Number(fee), receive: totalSats - Number(fee), hexLen: txHex.length });
  return txHex;
}

// ── Cooperative recovery (Boltz API) ─────────────────────────────

export async function cooperativeRecover(swapId: string): Promise<RecoveryResult> {
  try {
    const swap = await Swap.findOne({ swapId }).lean();
    if (!swap) return { success: false, error: `Swap ${swapId} not found` };
    if (!swap.preimage) return { success: false, error: 'No preimage' };

    const boltzId = swap.boltzSwapId;
    if (!boltzId) return { success: false, error: 'No Boltz swap ID' };

    logger.info('Recovery: cooperative claim via Boltz API', { swapId, boltzId });

    const { data } = await axios.post(
      `https://api.boltz.exchange/v2/swap/reverse/${boltzId}/claim`,
      { preimage: swap.preimage, pubNonce: '00'.repeat(32), partialSignature: '00'.repeat(32) },
      { timeout: 15000, validateStatus: () => true },
    );

    if (data?.error) {
      return { success: false, error: `Boltz: ${data.error}` };
    }

    await Swap.findOneAndUpdate(
      { swapId }, { status: 'completed', boltzStatus: 'recovered', completedAt: new Date() },
    );
    return { success: true, txid: data?.transactionId || 'claimed' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── Status ───────────────────────────────────────────────────────

export async function recoverySummary(): Promise<Array<{
  swapId: string; boltzId: string; hasPreimage: boolean;
  hasRecoveryData: boolean; status: string; sourceAmount: number;
}>> {
  const swaps = await Swap.find({
    direction: 'LN2ONCHAIN',
    status: { $in: ['pending', 'failed'] },
    preimage: { $exists: true, $ne: null },
  }).lean();

  return swaps.map((s: any) => ({
    swapId: s.swapId,
    boltzId: s.boltzSwapId,
    hasPreimage: !!s.preimage,
    hasRecoveryData: !!(s.lockupAddress && s.swapTree && s.refundPublicKey && s.timeoutBlockHeight),
    status: s.status,
    sourceAmount: s.sourceAmount,
  }));
}
