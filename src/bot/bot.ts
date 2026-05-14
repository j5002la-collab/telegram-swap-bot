import mongoose from 'mongoose';
import { Telegraf, Context } from 'telegraf';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { userMiddleware } from './middleware/user';
import { startCommand, handleStartCallback } from './commands/start';
import { helpCommand } from './commands/help';
import { swapCommand, handleSwapCurrency, handleSwapNetwork, handleSwapDirection, handleSwapAddress, handleSwapAmount, handleSwapConfirm, cancelCommand } from './commands/swap';
import { calcCommand, handleCalcText } from './commands/calc';
import { raffleCommand, handleRaffleWinners } from './commands/raffle';
import { adminCommand, handleAdminForceRaffle } from './commands/admin';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { errorMiddleware } from './middleware/error';
import { BoltzWebSocket } from '../boltz/websocket';
import { setSwapState } from './commands/swap';

export function createBot(boltzWs?: BoltzWebSocket): Telegraf<Context> {
  // Store WebSocket globally for swap commands to use
  if (boltzWs) setSwapState({ ws: boltzWs });
  const bot = new Telegraf<Context>(config.botToken);

  // Global middleware (order matters: rate-limit → error → user)
  bot.use(rateLimitMiddleware);
  bot.use(errorMiddleware);
  bot.use(userMiddleware);

  // Commands
  bot.start(startCommand);
  bot.help(helpCommand);
  bot.command('swap', swapCommand);
  bot.command('calc', calcCommand);
  bot.command('raffle', raffleCommand);
  bot.command('admin', adminCommand);
  bot.command('cancel', cancelCommand);

  // Callback handlers — swap flow
  bot.action(/^swap_cur_/, handleSwapCurrency);
  bot.action(/^swap_net_/, handleSwapNetwork);
  bot.action(/^swap_dir_/, handleSwapDirection);
  bot.action(/^swap_confirm$|^swap_cancel$/, handleSwapConfirm);
  bot.action('raffle_winners', handleRaffleWinners);
  bot.action('admin_force_raffle', handleAdminForceRaffle);
  bot.action(/^(start_swap|show_calc|show_raffle|show_help)$/, handleStartCallback);

  // Text handler for swap amount + calc input
  bot.on('text', handleSwapAmount);
  bot.on('text', handleCalcText);

  // Debug: log every message
  bot.use(async (ctx, next) => {
    logger.debug('MSG', { from: ctx.from?.first_name, text: ctx.message && 'text' in ctx.message ? ctx.message.text?.slice(0, 50) : '', update: ctx.updateType });
    await next();
  });

  // Error handler
  bot.catch((err: unknown, ctx: Context) => {
    logger.error('Bot error', {
      error: err instanceof Error ? err.message : String(err),
      updateType: ctx.updateType,
    });
  });

  // Store bot reference for async WebSocket updates
  setSwapState({ bot });

  return bot;
}

export async function launchBot(bot: Telegraf<Context>): Promise<void> {
  try {
    await bot.launch();
    logger.info('Bot launched successfully');

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
