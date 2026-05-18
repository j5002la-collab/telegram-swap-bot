/**
 * Auto-cleanup job: marks old stuck swaps as failed.
 * Runs at startup and every 24 hours.
 */
import { Swap } from '../models';
import { logger } from '../utils/logger';

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export async function cleanupOldSwaps(): Promise<{
  depositsCleaned: number;
  reverseCleaned: number;
}> {
  const now = Date.now();
  let depositsCleaned = 0;
  let reverseCleaned = 0;

  try {
    // ONCHAIN2LN swaps stuck in waiting_deposit for > 5 days
    const oldDeposits = await Swap.updateMany(
      {
        direction: 'ONCHAIN2LN',
        status: 'pending',
        boltzStatus: 'waiting_deposit',
        createdAt: { $lt: new Date(now - FIVE_DAYS_MS) },
      },
      {
        $set: { status: 'failed', boltzStatus: 'deposit_timeout' },
      },
    );
    depositsCleaned = oldDeposits.modifiedCount;

    // LN2ONCHAIN swaps stuck in pending for > 7 days
    const oldReverse = await Swap.updateMany(
      {
        direction: 'LN2ONCHAIN',
        status: 'pending',
        createdAt: { $lt: new Date(now - SEVEN_DAYS_MS) },
      },
      {
        $set: { status: 'failed', boltzStatus: 'swap_timeout' },
      },
    );
    reverseCleaned = oldReverse.modifiedCount;

    if (depositsCleaned > 0 || reverseCleaned > 0) {
      logger.info('Cleanup: old swaps marked as failed', {
        deposits: depositsCleaned,
        reverse: reverseCleaned,
      });
    }
  } catch (err) {
    logger.error('Cleanup job failed', { error: err });
  }

  return { depositsCleaned, reverseCleaned };
}

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startCleanupScheduler(): void {
  // Run immediately
  cleanupOldSwaps().catch((err) => logger.error('Initial cleanup failed', { error: err }));

  // Run every 24 hours
  cleanupInterval = setInterval(() => {
    cleanupOldSwaps().catch((err) => logger.error('Scheduled cleanup failed', { error: err }));
  }, 24 * 60 * 60 * 1000);

  logger.info('Swap cleanup scheduler started (every 24h)');
}

export function stopCleanupScheduler(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
