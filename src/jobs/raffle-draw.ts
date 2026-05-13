import schedule from 'node-schedule';
import { logger } from '../utils/logger';
import { raffleEngine } from '../engine/raffle';
import type { RaffleResult } from '../engine/raffle';

let raffleJob: schedule.Job | null = null;

/**
 * Start the weekly raffle scheduler. Runs every Sunday at 23:59 UTC.
 * @param onDraw Optional callback when draw executes (for broadcasting results)
 */
export function startRaffleScheduler(
  onDraw?: (result: RaffleResult) => Promise<void>,
): void {
  if (raffleJob) {
    logger.warn('Raffle scheduler already running');
    return;
  }

  // Every Sunday at 23:59 UTC
  raffleJob = schedule.scheduleJob(
    { dayOfWeek: 0, hour: 23, minute: 59, tz: 'Etc/UTC' },
    async () => {
      logger.info('Weekly raffle draw triggered');

      try {
        const result = await raffleEngine.executeDraw(async (winner) => {
          logger.info('Raffle payment pending', {
            winner: winner.winnerUsername,
            prizePool: winner.prizePool,
          });

          // TODO: integrate Boltz reverse swap to pay winner in Lightning
          // For now, log the payment intent
          if (onDraw) {
            await onDraw(winner);
          }
        });

        if (result) {
          logger.info('Raffle draw completed', {
            week: result.weekNumber,
            winner: result.winnerUsername,
            prize: result.prizePool,
          });
        }
      } catch (error) {
        logger.error('Raffle draw failed', { error });
      }
    },
  );

  logger.info('Raffle scheduler started (Sundays 23:59 UTC)');
}

/**
 * Execute the raffle draw immediately (admin command).
 */
export async function forceRaffleDraw(): Promise<RaffleResult | null> {
  logger.info('Admin forced raffle draw');
  return raffleEngine.executeDraw(async (winner) => {
    logger.info('Admin draw payment', {
      winner: winner.winnerUsername,
      prize: winner.prizePool,
    });
  });
}

/**
 * Stop the raffle scheduler.
 */
export function stopRaffleScheduler(): void {
  if (raffleJob) {
    raffleJob.cancel();
    raffleJob = null;
    logger.info('Raffle scheduler stopped');
  }
}
