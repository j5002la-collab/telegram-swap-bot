import { config } from '../utils/config';
import { logger } from '../utils/logger';
import type { RateInfo } from './rates';

export interface FeeBreakdown {
  /** Source amount in smallest unit */
  sourceAmount: number;
  /** Bot commission rate (% like 2.5) */
  commissionRate: number;
  /** Bot commission in smallest unit */
  commissionAmount: number;
  /** Boltz fee rate (% like 0.5) */
  boltzFeeRate: number;
  /** Boltz fee in smallest unit */
  boltzFeeAmount: number;
  /** Boltz miner fee in sats */
  boltzMinerFee: number;
  /** Total fees in smallest unit */
  totalFees: number;
  /** Net amount to swap after all fees */
  netSwapAmount: number;
  /** Estimated receive amount in destination currency (smallest unit) */
  estimatedReceive: number;
  /** Bot profit in smallest unit */
  botProfit: number;
}

export class CommissionEngine {
  private commissionRate: number;

  constructor(commissionRate?: number) {
    this.commissionRate = commissionRate ?? config.commissionRate;
  }

  /**
   * Calculate commission on a source amount.
   * All amounts are in smallest unit (sats for BTC, cents for USDT/USDC).
   */
  calculateCommission(sourceAmount: number): number {
    return Math.floor(sourceAmount * (this.commissionRate / 100));
  }

  /**
   * Get the net amount after deducting commission.
   */
  getNetAfterCommission(sourceAmount: number): number {
    return sourceAmount - this.calculateCommission(sourceAmount);
  }

  /**
   * Calculate the full fee breakdown for a swap.
   */
  calculateFeeBreakdown(sourceAmount: number, rateInfo: RateInfo): FeeBreakdown {
    const commissionAmount = this.calculateCommission(sourceAmount);

    // Boltz fee is calculated on the net amount after bot commission
    const amountForBoltz = sourceAmount - commissionAmount;
    const boltzFeeAmount = Math.ceil(amountForBoltz * (rateInfo.boltzFeePct / 100));
    const boltzMinerFee = rateInfo.boltzMinerFee || 0;

    // Total deduction
    const totalFees = commissionAmount + boltzFeeAmount + boltzMinerFee;
    const netSwapAmount = sourceAmount - totalFees;

    // Estimated receive: apply the userRate to net amount
    const estimatedReceive = Math.max(
      0,
      Math.floor(netSwapAmount * rateInfo.userRate),
    );

    // What the bot keeps (after paying Boltz from its commission — bot eats the Boltz fee internally)
    const botProfit = commissionAmount;

    return {
      sourceAmount,
      commissionRate: this.commissionRate,
      commissionAmount,
      boltzFeeRate: rateInfo.boltzFeePct,
      boltzFeeAmount,
      boltzMinerFee,
      totalFees,
      netSwapAmount,
      estimatedReceive,
      botProfit,
    };
  }

  /**
   * Format fee breakdown as a Telegram message.
   * All amounts are in smallest unit — convert to human-readable for display.
   */
  formatBreakdown(fee: FeeBreakdown, sourceLabel: string, destLabel: string): string {
    const lines = [
      `📋 *Resumen de tu swap*`,
      '',
      `Convertir: ${this.formatAmount(fee.sourceAmount, sourceLabel)}`,
      `Recibirás: ${this.formatAmount(fee.estimatedReceive, destLabel)}`,
      '',
      `*Comisiones:*`,
      `  ├── SwapBot \\(${fee.commissionRate}%\\): ${this.formatAmount(fee.commissionAmount, sourceLabel)}`,
      `  └── Boltz \\(${fee.boltzFeeRate}% \\+ ${fee.boltzMinerFee} sats\\): ~${this.formatAmount(fee.boltzFeeAmount + fee.boltzMinerFee, sourceLabel)}`,
      '',
      `⏱ Tiempo estimado: 1\\-5 minutos`,
    ];

    return lines.join('\n');
  }

  /**
   * Format an amount for display.
   * Smallest unit → human readable.
   */
  formatAmount(amountSmallest: number, currency: string): string {
    if (currency === 'sats' || currency === 'BTC') {
      const btc = amountSmallest / 100_000_000;
      return `${amountSmallest.toLocaleString()} sats \\(${btc.toFixed(8)} BTC\\)`;
    }
    if (currency === 'USDT' || currency === 'USDC' || currency === 'cents') {
      const usd = amountSmallest / 100;
      return `${usd.toFixed(2)} ${currency}`;
    }
    return `${amountSmallest.toLocaleString()} ${currency}`;
  }

  /**
   * Check if amount is below minimum commission threshold.
   * Returns false if the swap is too small to be profitable.
   */
  isProfitable(sourceAmount: number, minCommissionUsd = 0.10): boolean {
    // Commission must be at least $0.10 equivalent
    const commissionUsd = sourceAmount * (this.commissionRate / 100);
    return commissionUsd >= minCommissionUsd;
  }

  /**
   * Get current commission rate.
   */
  getCommissionRate(): number {
    return this.commissionRate;
  }

  /**
   * Set commission rate at runtime (admin command).
   */
  setCommissionRate(rate: number): void {
    if (rate < 0 || rate > 10) {
      throw new Error('Commission rate must be between 0% and 10%');
    }
    this.commissionRate = rate;
    logger.info('Commission rate changed', { newRate: rate });
  }
}

export const commissionEngine = new CommissionEngine();
