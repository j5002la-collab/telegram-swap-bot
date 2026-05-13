import { Context } from 'telegraf';
import { showHelp } from './start';

export async function helpCommand(ctx: Context): Promise<void> {
  await showHelp(ctx);
}
