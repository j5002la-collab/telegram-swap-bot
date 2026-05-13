import { config } from './utils/config';
import { logger } from './utils/logger';
import { connectDatabase } from './models';
import { createBot, launchBot } from './bot/bot';
import { startRaffleScheduler } from './jobs/raffle-draw';

async function main(): Promise<void> {
  logger.info('Starting Telegram Swap Bot...', {
    commissionRate: config.commissionRate,
    boltzApiUrl: config.boltzApiUrl,
    adminCount: config.adminIds.length,
  });

  try {
    // Connect to MongoDB
    await connectDatabase();

    // Start raffle scheduler (Sundays 23:59 UTC)
    startRaffleScheduler();

    // Create and launch bot
    const bot = createBot();
    await launchBot(bot);

    logger.info('Telegram Swap Bot is running');
  } catch (error) {
    logger.error('Fatal error during startup', { error });
    process.exit(1);
  }
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { error: reason });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
  process.exit(1);
});

main();
