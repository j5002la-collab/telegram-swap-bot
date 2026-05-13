import { Context, Middleware } from 'telegraf';
import { User } from '../../models';

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

    let user = await User.findOne({ telegramId });

    if (user) {
      user.lastSeen = new Date();
      user.username = username;
      user.firstName = firstName;
      await user.save();
    } else {
      user = await User.create({
        telegramId,
        username,
        firstName,
        firstSeen: new Date(),
        lastSeen: new Date(),
      });
    }

    setUserState(ctx, {
      userId: telegramId,
      username: username || firstName,
      isNewUser: user.swapsCount === 0,
    });
  } catch (error) {
    console.error('User middleware error:', error);
  }

  await next();
};
