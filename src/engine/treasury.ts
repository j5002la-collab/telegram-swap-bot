import { Treasury } from '../models';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { commissionEngine } from './commission';

export interface TreasuryBalance {
  accumulated: number;
  withdrawn: number;
  balance: number;
  lightningAddress: string;
  btcAddress: string;
}

export class TreasuryEngine {
  async initialize(): Promise<void> {
    let treasury = await Treasury.findOne();
    if (!treasury) {
      treasury = await Treasury.create({
        accumulated: 0,
        withdrawn: 0,
        balance: 0,
        lightningAddress: config.lightningAddress,
        btcAddress: config.btcAddress,
      });
    } else {
      if (treasury.lightningAddress !== config.lightningAddress) {
        treasury.lightningAddress = config.lightningAddress;
      }
      if (treasury.btcAddress !== config.btcAddress) {
        treasury.btcAddress = config.btcAddress;
      }
      await treasury.save();
    }

    logger.info('Treasury initialized', {
      balance: treasury.balance,
      lightningAddress: treasury.lightningAddress || '(not set)',
    });
  }

  async trackEarnings(amountInSats: number): Promise<void> {
    if (amountInSats <= 0) return;
    try {
      const treasury = await Treasury.findOne();
      if (treasury) {
        treasury.accumulated += amountInSats;
        treasury.balance = treasury.accumulated - treasury.withdrawn;
        await treasury.save();
        logger.info('Treasury: +' + amountInSats + ' sats earned', {
          totalAccumulated: treasury.accumulated,
          balance: treasury.balance,
        });
      }
    } catch (error) {
      logger.error('Treasury tracking failed', { error });
    }
  }

  async getBalance(): Promise<TreasuryBalance> {
    const treasury = await Treasury.findOne();
    return {
      accumulated: treasury?.accumulated || 0,
      withdrawn: treasury?.withdrawn || 0,
      balance: treasury?.balance || 0,
      lightningAddress: treasury?.lightningAddress || config.lightningAddress,
      btcAddress: treasury?.btcAddress || config.btcAddress,
    };
  }

  async recordWithdrawal(amountInSats: number): Promise<void> {
    const treasury = await Treasury.findOne();
    if (!treasury) throw new Error('Treasury not initialized');
    if (amountInSats > treasury.balance) {
      throw new Error(
        'Saldo insuficiente: ' + treasury.balance + ' sats disponibles, ' + amountInSats + ' solicitados',
      );
    }
    treasury.withdrawn += amountInSats;
    treasury.balance = treasury.accumulated - treasury.withdrawn;
    await treasury.save();
    logger.info('Treasury withdrawal', { amount: amountInSats, balance: treasury.balance });
  }

  formatBalance(b: TreasuryBalance): string {
    const addr = b.lightningAddress || b.btcAddress || 'No configurada';
    const addrShort = addr.length > 30 ? addr.slice(0, 30) + '...' : addr;

    return (
      'Tesoreria BTC/Lightning\n\n' +
      'Balance: ' + commissionEngine.formatAmount(b.balance, 'sats') + '\n' +
      'Retirado: ' + commissionEngine.formatAmount(b.withdrawn, 'sats') + '\n' +
      'Total acumulado: ' + commissionEngine.formatAmount(b.accumulated, 'sats') + '\n' +
      'Wallet: ' + addrShort + '\n\n' +
      '/admin withdraw <sats> para retiro manual.'
    );
  }
}

export const treasuryEngine = new TreasuryEngine();
