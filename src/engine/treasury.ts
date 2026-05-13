import { Treasury, CurrencyType } from '../models';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { commissionEngine } from './commission';

export interface TreasuryBalance {
  currency: CurrencyType;
  accumulated: number;
  withdrawn: number;
  balance: number;
  walletAddress: string;
}

export class TreasuryEngine {
  /**
   * Initialize treasury accounts for all currencies.
   * Called on bot startup.
   */
  async initialize(): Promise<void> {
    const currencies: { currency: CurrencyType; address: string }[] = [
      { currency: 'BTC', address: config.wallets.lightningAddress || config.wallets.btcAddress },
      { currency: 'USDT', address: config.wallets.usdtAddress },
      { currency: 'USDC', address: config.wallets.usdcAddress },
    ];

    for (const { currency, address } of currencies) {
      await Treasury.findOneAndUpdate(
        { currency },
        { $setOnInsert: { currency, walletAddress: address, accumulated: 0, withdrawn: 0, balance: 0 } },
        { upsert: true, new: true },
      );
    }

    logger.info('Treasury accounts initialized');
  }

  /**
   * Track commission earnings from a completed swap.
   * Called after every successful swap.
   */
  async trackEarnings(
    currency: CurrencyType,
    amountInSmallestUnit: number,
  ): Promise<void> {
    if (amountInSmallestUnit <= 0) return;

    try {
      const treasury = await Treasury.findOne({ currency });

      if (treasury) {
        treasury.accumulated += amountInSmallestUnit;
        treasury.balance = treasury.accumulated - treasury.withdrawn;
        // Update wallet address if changed in config
        const configAddress = this.getAddressForCurrency(currency);
        if (configAddress && treasury.walletAddress !== configAddress) {
          treasury.walletAddress = configAddress;
        }
        await treasury.save();
      }

      logger.info('Treasury earnings tracked', {
        currency,
        amount: amountInSmallestUnit,
        totalAccumulated: treasury?.accumulated,
      });
    } catch (error) {
      logger.error('Failed to track treasury earnings', { error });
    }
  }

  /**
   * Get all treasury balances for admin display.
   */
  async getBalances(): Promise<TreasuryBalance[]> {
    const treasuries = await Treasury.find().sort({ currency: 1 });
    return treasuries.map((t) => ({
      currency: t.currency,
      accumulated: t.accumulated,
      withdrawn: t.withdrawn,
      balance: t.balance,
      walletAddress: t.walletAddress,
    }));
  }

  /**
   * Record a withdrawal (manual by admin).
   */
  async recordWithdrawal(
    currency: CurrencyType,
    amountInSmallestUnit: number,
  ): Promise<void> {
    const treasury = await Treasury.findOne({ currency });
    if (!treasury) {
      throw new Error(`No treasury account for ${currency}`);
    }

    if (amountInSmallestUnit > treasury.balance) {
      throw new Error(
        `Insufficient balance: ${treasury.balance} available, ${amountInSmallestUnit} requested`,
      );
    }

    treasury.withdrawn += amountInSmallestUnit;
    treasury.balance = treasury.accumulated - treasury.withdrawn;
    await treasury.save();

    logger.info('Treasury withdrawal recorded', {
      currency,
      amount: amountInSmallestUnit,
      newBalance: treasury.balance,
    });
  }

  /**
   * Get the wallet address for a currency from config.
   */
  getAddressForCurrency(currency: CurrencyType): string {
    switch (currency) {
      case 'BTC':
        return config.wallets.lightningAddress || config.wallets.btcAddress;
      case 'USDT':
        return config.wallets.usdtAddress;
      case 'USDC':
        return config.wallets.usdcAddress;
      default:
        return '';
    }
  }

  /**
   * Format treasury balance for Telegram display.
   */
  formatBalances(balances: TreasuryBalance[]): string {
    const lines = ['🏦 *Tesorería — Ganancias Acumuladas*', ''];

    if (balances.length === 0) {
      lines.push('No hay cuentas configuradas\\.');
      return lines.join('\n');
    }

    for (const b of balances) {
      const formatted = commissionEngine.formatAmount(b.balance, b.currency);
      const addrShort = b.walletAddress
        ? b.walletAddress.slice(0, 12) + '...'
        : 'No configurada';

      lines.push(`*${b.currency}*`);
      lines.push(`  💰 Balance: ${formatted}`);
      lines.push(`  📤 Retirado: ${commissionEngine.formatAmount(b.withdrawn, b.currency)}`);
      lines.push(`  📥 Total: ${commissionEngine.formatAmount(b.accumulated, b.currency)}`);
      lines.push(`  🏦 Address: \`${addrShort}\``);
      lines.push('');
    }

    return lines.join('\n');
  }
}

export const treasuryEngine = new TreasuryEngine();
