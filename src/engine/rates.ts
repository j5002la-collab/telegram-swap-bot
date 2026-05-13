import { boltzClient } from '../boltz/client';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import type { BoltzPair, SubmarinePairs, ReversePairs, ChainPairs } from '../boltz/types';

// --- Rate data structures ---

export interface RateInfo {
  /** Raw Boltz rate: how many sats per 1 unit of source currency */
  boltzRate: number;
  /** Rate with bot commission applied */
  userRate: number;
  /** Raw Boltz fee percentage */
  boltzFeePct: number;
  /** Boltz miner fees in sats */
  boltzMinerFee: number;
  /** Bot commission percentage */
  botCommissionPct: number;
  /** Bot commission in smallest unit */
  botCommissionAmount: number;
  /** Minimum amount in smallest unit */
  minAmount: number;
  /** Maximum amount in smallest unit */
  maxAmount: number;
  /** Pair hash for validation */
  pairHash: string;
}

export interface RateDisplay {
  direction: string;
  description: string;
  botRateInfo: RateInfo;
  /** Gas/network fee estimate in USD */
  estimatedNetworkFeeUsd: number;
}

interface RateCache {
  data: SubmarinePairs | ReversePairs | ChainPairs;
  fetchedAt: number;
}

class RateEngine {
  private submarineCache: RateCache | null = null;
  private reverseCache: RateCache | null = null;
  private chainCache: RateCache | null = null;
  private ttlMs = 30_000; // 30 seconds

  /**
   * Get a pair from Boltz and calculate the user-facing rate with commission.
   */
  async getRate(
    direction: 'submarine' | 'reverse' | 'chain',
    fromCurrency: string,
    toCurrency: string,
  ): Promise<RateInfo | null> {
    let pairs: Record<string, Record<string, BoltzPair>>;

    try {
      switch (direction) {
        case 'submarine':
          pairs = await this.getCachedSubmarinePairs();
          break;
        case 'reverse':
          pairs = await this.getCachedReversePairs();
          break;
        case 'chain':
          pairs = await this.getCachedChainPairs();
          break;
      }
    } catch (error) {
      logger.error('Failed to fetch pairs from Boltz', { error });
      return null;
    }

    const fromPairs = pairs[fromCurrency];
    if (!fromPairs) {
      logger.warn('No pairs for currency', { fromCurrency });
      return null;
    }

    const pair = fromPairs[toCurrency];
    if (!pair) {
      logger.warn('No pair for direction', { from: fromCurrency, to: toCurrency });
      return null;
    }

    return this.calculateRateInfo(pair);
  }

  /**
   * Calculate the full rate info including bot commission.
   */
  private calculateRateInfo(pair: BoltzPair): RateInfo {
    const boltzFeePct = pair.fees.percentage;
    const boltzMinerFee =
      typeof pair.fees.minerFees === 'number'
        ? pair.fees.minerFees
        : (pair.fees.minerFees.server || 0) + (pair.fees.minerFees.user?.claim || 0) + (pair.fees.minerFees.user?.lockup || 0);

    const botCommissionPct = config.commissionRate;

    // User rate = boltzRate * (1 - botFee/100 - botCommission/100)
    // This means the user gets less sats per unit because of fees
    const feeMultiplier = 1 - (boltzFeePct + botCommissionPct) / 100;
    const userRate = pair.rate * feeMultiplier;

    return {
      boltzRate: pair.rate,
      userRate: Math.max(userRate, 0), // Prevent negative rates
      boltzFeePct,
      boltzMinerFee,
      botCommissionPct,
      botCommissionAmount: 0, // Calculated when amount is known
      minAmount: pair.limits.minimal,
      maxAmount: pair.limits.maximal,
      pairHash: pair.hash,
    };
  }

  /**
   * Calculate the user's receive amount and commission with a given source amount.
   */
  calculateAmounts(sourceAmount: number, rateInfo: RateInfo): {
    receiveAmount: number;
    commissionAmount: number;
    boltzFeeAmount: number;
    netAmount: number;
  } {
    // Amount is in smallest unit (sats or cents)
    // Commission is a percentage of source amount
    const commissionAmount = Math.floor(sourceAmount * (rateInfo.botCommissionPct / 100));
    const boltzFeeAmount = Math.floor(sourceAmount * (rateInfo.boltzFeePct / 100));
    const netAmount = sourceAmount - commissionAmount - boltzFeeAmount - rateInfo.boltzMinerFee;
    const receiveAmount = Math.floor(netAmount * (rateInfo.boltzRate / rateInfo.boltzRate)); // Rate is 1:1 for same currency

    // For cross-currency: receiveAmount = netAmount_after_commission * boltzRate
    // But we need to convert to destination currency
    const receiveAmountCross = Math.floor(
      (sourceAmount - commissionAmount) * rateInfo.userRate
    ) - rateInfo.boltzMinerFee;

    return {
      receiveAmount: Math.max(0, receiveAmountCross),
      commissionAmount,
      boltzFeeAmount,
      netAmount: Math.max(0, netAmount),
    };
  }

  /**
   * Get a display-friendly rate description.
   */
  formatRateDisplay(rateInfo: RateInfo, directionLabel: string): string {
    const lines = [
      `📊 *Tasa actual:* ${directionLabel}`,
      '',
      `💱 Tasa Boltz: 1 = ${rateInfo.boltzRate.toFixed(2)}`,
      `💰 Tu tasa (con comisión): 1 = ${rateInfo.userRate.toFixed(2)}`,
      '',
      `📋 *Comisiones:*`,
      `  ├── Boltz fee: ${rateInfo.boltzFeePct}% + ${rateInfo.boltzMinerFee} sats`,
      `  └── SwapBot fee: ${rateInfo.botCommissionPct}%`,
      '',
      `📏 Mín: ${rateInfo.minAmount.toLocaleString()} | Máx: ${rateInfo.maxAmount.toLocaleString()} sats`,
    ];
    return lines.join('\n');
  }

  // --- Cached pair fetching ---

  private async getCachedSubmarinePairs(): Promise<SubmarinePairs> {
    if (this.submarineCache && Date.now() - this.submarineCache.fetchedAt < this.ttlMs) {
      return this.submarineCache.data as SubmarinePairs;
    }
    const data = await boltzClient.getSubmarinePairs();
    this.submarineCache = { data, fetchedAt: Date.now() };
    return data;
  }

  private async getCachedReversePairs(): Promise<ReversePairs> {
    if (this.reverseCache && Date.now() - this.reverseCache.fetchedAt < this.ttlMs) {
      return this.reverseCache.data as ReversePairs;
    }
    const data = await boltzClient.getReversePairs();
    this.reverseCache = { data, fetchedAt: Date.now() };
    return data;
  }

  private async getCachedChainPairs(): Promise<ChainPairs> {
    if (this.chainCache && Date.now() - this.chainCache.fetchedAt < this.ttlMs) {
      return this.chainCache.data as ChainPairs;
    }
    const data = await boltzClient.getChainPairs();
    this.chainCache = { data, fetchedAt: Date.now() };
    return data;
  }
}

export const rateEngine = new RateEngine();
