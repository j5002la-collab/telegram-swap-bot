import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';
import * as bitcoin from 'bitcoinjs-lib';
import axios from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

const ECPair = ECPairFactory(ecc);
bitcoin.initEccLib(ecc); // Required for Taproot (bc1p) address handling

export interface DepositInfo {
  txid: string;
  vout: number;
  amount: number; // sats
  confirmations: number;
  address: string;
}

export interface WalletStatus {
  address: string;
  initialized: boolean;
  error?: string;
}

let keyPair: ReturnType<typeof ECPair.fromWIF> | null = null;

/** Get the hex-encoded public key for claim/reverse swaps. Returns null if wallet not initialized. */
export function getPublicKeyHex(): string | null {
  if (!keyPair) return null;
  return Buffer.from(keyPair.publicKey).toString('hex');
}

/**
 * Initialize wallet from WIF private key in config.
 */
export function initWallet(): WalletStatus {
  if (!config.btcPrivateKeyWif) {
    return { address: config.btcAddress, initialized: false, error: 'WALLET_BTC_PRIVATE_KEY not configured' };
  }

  try {
    keyPair = ECPair.fromWIF(config.btcPrivateKeyWif);
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: Buffer.from(keyPair.publicKey),
      network: bitcoin.networks.bitcoin,
    });

    if (address && config.btcAddress && address !== config.btcAddress) {
      logger.warn('Wallet address mismatch', {
        derived: address,
        configured: config.btcAddress,
      });
    }

    logger.info('Wallet initialized', {
      address: address || 'unknown',
      hasKey: true,
    });

    return { address: address || config.btcAddress, initialized: true };
  } catch (error) {
    logger.error('Failed to initialize wallet', { error });
    return { address: config.btcAddress, initialized: false, error: String(error) };
  }
}

/**
 * Monitor for deposits to our address via mempool.space API.
 * Returns deposits that are new since last check.
 */
export async function checkDeposits(sinceTxid?: string): Promise<DepositInfo[]> {
  if (!config.btcAddress) return [];

  try {
    const url = `https://mempool.space/api/address/${config.btcAddress}/txs`;
    const { data } = await axios.get<Array<{
      txid: string;
      vin: Array<{ prevout: { scriptpubkey_address: string } }>;
      vout: Array<{ scriptpubkey_address: string; value: number }>;
      status: { confirmed: boolean; block_height?: number };
    }>>(url, { timeout: 10000 });

    const deposits: DepositInfo[] = [];
    for (const tx of data) {
      // Only count outputs TO our address
      for (let i = 0; i < tx.vout.length; i++) {
        const vout = tx.vout[i];
        if (vout.scriptpubkey_address === config.btcAddress) {
          // Skip if we've already seen this (simple dedup by txid)
          if (sinceTxid && tx.txid === sinceTxid) continue;

          deposits.push({
            txid: tx.txid,
            vout: i,
            amount: vout.value, // value is in sats
            confirmations: tx.status.confirmed ? 1 : 0,
            address: config.btcAddress,
          });
        }
      }
    }

    if (deposits.length > 0) {
      logger.info('Deposits detected', { count: deposits.length });
    }

    return deposits;
  } catch (error) {
    logger.error('Failed to check deposits', { error });
    return [];
  }
}

/**
 * Wait for a deposit of at least minAmount sats to our address.
 * Polls every 20 seconds, times out after `timeoutMinutes`.
 */
export async function waitForDeposit(
  minAmount: number,
  timeoutMinutes = 60,
): Promise<DepositInfo | null> {
  const maxPolls = (timeoutMinutes * 60) / 20;
  logger.info('Waiting for deposit', { minAmount, address: config.btcAddress, timeoutMin: timeoutMinutes });

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, 20_000));
    const deposits = await checkDeposits();

    for (const d of deposits) {
      if (d.amount >= minAmount && d.confirmations > 0) {
        logger.info('Deposit confirmed', { txid: d.txid, amount: d.amount });
        return d;
      }
    }

    if (i % 3 === 0 && i > 0) {
      logger.debug('Still waiting for deposit', { poll: i + 1, maxPolls });
    }
  }

  logger.warn('Deposit timeout', { minAmount, timeoutMin: timeoutMinutes });
  return null;
}

/**
 * Check if wallet is ready for outbound transactions.
 */
export function isWalletReady(): boolean {
  return keyPair !== null && !!config.btcAddress;
}

/**
 * Get our wallet address.
 */
export function getWalletAddress(): string {
  return config.btcAddress || '';
}

// ---- Transaction building & sending ----

interface Utxo {
  txid: string;
  vout: number;
  value: number; // sats (mempool.space returns value as integer sats)
}

/** Fetch UTXOs for our address from mempool.space */
async function getUtxos(): Promise<Utxo[]> {
  const url = `https://mempool.space/api/address/${config.btcAddress}/utxo`;
  const { data } = await axios.get<Array<{
    txid: string;
    vout: number;
    value: number;
    status: { confirmed: boolean };
  }>>(url, { timeout: 10000 });

  return data
    .filter((u) => u.status.confirmed)
    .map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value, // mempool.space returns value in sats (integer)
    }));
}

/** Get fee rate from mempool.space */
async function getFeeRate(satsPerVbyte = 5): Promise<number> {
  try {
    const { data } = await axios.get<{ fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number }>(
      'https://mempool.space/api/v1/fees/recommended',
      { timeout: 5000 },
    );
    // Use economy fee unless it's very low
    return Math.max(data.economyFee || 1, satsPerVbyte);
  } catch {
    return satsPerVbyte;
  }
}

/**
 * Build, sign and broadcast a transaction sending BTC from our wallet.
 * @returns txid of the broadcast transaction, or null on failure.
 */
export async function sendToAddress(
  toAddress: string,
  amountSats: number,
): Promise<string | null> {
  if (!keyPair) {
    logger.error('Cannot send: wallet not initialized');
    return null;
  }

  try {
    const utxos = await getUtxos();
    if (utxos.length === 0) {
      logger.error('No UTXOs available');
      return null;
    }

    const feeRate = await getFeeRate();
    logger.info('Building transaction', { to: toAddress, amount: amountSats, utxos: utxos.length, feeRate });

    // Derive the script for our own address (needed for witnessUtxo)
    const ownScript = bitcoin.address.toOutputScript(config.btcAddress, bitcoin.networks.bitcoin);

    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
    let totalInput = 0;

    // Select UTXOs until we have enough
    for (const utxo of utxos) {
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: ownScript,
          value: BigInt(utxo.value),
        },
      });

      totalInput += utxo.value;

      if (totalInput >= amountSats + 2000) break; // +2000 sats buffer for fees
    }

    if (totalInput < amountSats) {
      logger.error('Insufficient funds', { totalInput, needed: amountSats });
      return null;
    }

    // Add output to destination
    logger.debug('sendToAddress: adding output', { to: toAddress, amount: amountSats });
    psbt.addOutput({ address: toAddress, value: BigInt(amountSats) });

    // Estimate fee and add change output
    // p2wpkh input: ~68 vB, output: ~31 vB, overhead: ~10 vB
    const estimatedSize = psbt.inputCount * 68 + (psbt.txOutputs.length + 1) * 31 + 10;
    const fee = estimatedSize * feeRate;
    const change = totalInput - amountSats - fee;

    if (change > 546) {
      // Dust limit: 546 sats
      const { address: changeAddress } = bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(keyPair.publicKey),
        network: bitcoin.networks.bitcoin,
      });
      if (changeAddress) {
        psbt.addOutput({ address: changeAddress, value: BigInt(change) });
      }
    }

    logger.info('Transaction details', { inputs: psbt.inputCount, amount: amountSats, fee, change });

    // Sign all inputs
    logger.debug('sendToAddress: signing inputs', { count: psbt.inputCount });
    for (let i = 0; i < psbt.inputCount; i++) {
      psbt.signInput(i, keyPair);
    }

    logger.debug('sendToAddress: finalizing');
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    const txHex = tx.toHex();

    // Broadcast via mempool.space
    logger.debug('sendToAddress: broadcasting', { hexLen: txHex.length });
    const { data: broadcastResult } = await axios.post<string>(
      'https://mempool.space/api/tx',
      txHex,
      { headers: { 'Content-Type': 'text/plain' }, timeout: 10000 },
    );

    logger.info('Transaction broadcast', { txid: broadcastResult, amount: amountSats, to: toAddress });
    return broadcastResult;
  } catch (error: any) {
    const body = error?.response?.data;
    const detail = body
      ? `${error.message} | response: ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`
      : error?.message || String(error);
    logger.error('Failed to send transaction', { error: detail, to: toAddress, amount: amountSats });
    return null;
  }
}
