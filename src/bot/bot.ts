import mongoose from 'mongoose';
import { Telegraf, Context } from 'telegraf';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { userMiddleware } from './middleware/user';
import { startCommand, handleStartCallback } from './commands/start';
import { helpCommand } from './commands/help';
import { swapCommand, handleSwapDirection, handleSwapAmount, handleSwapConfirm } from './commands/swap';
import { ratesCommand, handleRefreshRates } from './commands/rates';
import { raffleCommand, handleRaffleWinners } from './commands/raffle';
import { adminCommand, handleAdminForceRaffle } from './commands/admin';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { errorMiddleware } from './middleware/error';

export function createBot(): Telegraf<Context> {
  const bot = new Telegraf<Context>(config.botToken);

  // Global middleware (order matters: rate-limit → error → user)
  bot.use(rateLimitMiddleware);
  bot.use(errorMiddleware);
  bot.use(userMiddleware);

  // Commands
  bot.start(startCommand);
  bot.help(helpCommand);
  bot.command('swap', swapCommand);
  bot.command('rates', ratesCommand);
  bot.command('raffle', raffleCommand);
  bot.command('admin', adminCommand);

  // Callback handlers — specific patterns first, then general
  bot.action(/^swap_dir_/, handleSwapDirection);
  bot.action(/^swap_confirm$|^swap_cancel$/, handleSwapConfirm);
  bot.action('refresh_rates', handleRefreshRates);
  bot.action('raffle_winners', handleRaffleWinners);
  bot.action('admin_force_raffle', handleAdminForceRaffle);
  bot.action(/^(start_swap|show_rates|show_raffle|show_help)$/, handleStartCallback);

  // Text handler for swap amount input
  bot.on('text', handleSwapAmount);

  // Error handler
  bot.catch((err: unknown, ctx: Context) => {
    logger.error('Bot error', {
      error: err instanceof Error ? err.message : String(err),
      updateType: ctx.updateType,
    });
  });

  return bot;
}

export async function launchBot(bot: Telegraf<Context>): Promise<void> {
  try {
    await bot.launch();
    logger.info('Bot launched successfully');

    // Enable graceful stop
    const gracefulShutdown = async () => {
      logger.info('Shutting down gracefully...');
      bot.stop();
      await mongoose.disconnect();
      logger.info('Shutdown complete');
      process.exit(0);
    };

    process.once('SIGINT', () => gracefulShutdown());
    process.once('SIGTERM', () => gracefulShutdown());
  } catch (error) {
    logger.error('Failed to launch bot', { error });
    throw error;
  }
}
