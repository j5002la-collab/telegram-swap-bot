import { Telegraf, Context } from 'telegraf';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { userMiddleware } from './middleware/user';
import { startCommand, handleStartCallback } from './commands/start';
import { helpCommand } from './commands/help';

export function createBot(): Telegraf<Context> {
  const bot = new Telegraf<Context>(config.botToken);

  // Global middleware
  bot.use(userMiddleware);

  // Commands
  bot.start(startCommand);
  bot.help(helpCommand);

  // Callback handlers
  bot.action(/^(start_swap|show_rates|show_raffle|show_help)$/, handleStartCallback);

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
    const stopBot = () => {
      logger.info('Stopping bot...');
      bot.stop();
    };

    process.once('SIGINT', stopBot);
    process.once('SIGTERM', stopBot);
  } catch (error) {
    logger.error('Failed to launch bot', { error });
    throw error;
  }
}
