import { Context, Middleware } from 'telegraf';
import { User } from '../../models';
import { logger } from '../../utils/logger';

export interface UserState {
  userId: string;
  username: string;
  isNewUser: boolean;
}

/**
 * Safely read the user state from ctx.state
 */
export function getUserState(ctx: Context): UserState | undefined {
  return ctx.state.user as UserState | undefined;
}

/**
 * Safely set the user state on ctx.state
 */
export function setUserState(ctx: Context, userState: UserState): void {
  ctx.state.user = userState;
}

export const userMiddleware: Middleware<Context> = async (ctx, next) => {
  if (!ctx.from) {
    await next();
    return;
  }

  try {
    const telegramId = String(ctx.from.id);
    const username = ctx.from.username || '';
    const firstName = ctx.from.first_name || '';

    // Atomic upsert: always keep username/firstName in sync
    const user = await User.findOneAndUpdate(
      { telegramId },
      {
        $set: { username, firstName },
        $setOnInsert: { firstSeen: new Date(), lastSeen: new Date() },
      },
      { upsert: true, new: true },
    );

    // Debounced lastSeen: only touch if >2 min stale (optimistic lock)
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    if (user.lastSeen < twoMinutesAgo) {
      await User.updateOne(
        { telegramId, lastSeen: user.lastSeen }, // optimistic lock
        { $set: { lastSeen: new Date() } },
      );
    }

    setUserState(ctx, {
      userId: telegramId,
      username: username || firstName,
      isNewUser: user.swapsCount === 0,
    });
  } catch (error) {
    logger.error('User middleware error', { error });
  }

  await next();
};
