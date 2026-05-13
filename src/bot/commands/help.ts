import { Context } from 'telegraf';
import { showHelp } from './showHelp';

export async function helpCommand(ctx: Context): Promise<void> {
  await showHelp(ctx);
}
