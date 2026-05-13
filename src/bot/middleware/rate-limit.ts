import { Context, Middleware } from 'telegraf';
import { logger } from '../../utils/logger';
import { config } from '../../utils/config';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

class RateLimiter {
  private store = new Map<string, RateLimitEntry>();
  private windowMs = 60_000; // 1 minute
  private maxRequests = 15; // 15 messages per minute

  /** Clean up expired entries every 5 minutes */
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60_000);
  }

  private getKey(ctx: Context): string {
    return String(ctx.from?.id || ctx.chat?.id || 'unknown');
  }

  isLimited(ctx: Context): boolean {
    const key = this.getKey(ctx);
    const now = Date.now();
    let entry = this.store.get(key);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.store.set(key, entry);
    }

    entry.count++;
    return entry.count > this.maxRequests;
  }

  getRemainingTime(ctx: Context): number {
    const key = this.getKey(ctx);
    const entry = this.store.get(key);
    if (!entry) return 0;
    return Math.max(0, Math.ceil((entry.resetAt - Date.now()) / 1000));
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.resetAt) {
        this.store.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.store.clear();
  }
}

export const rateLimiter = new RateLimiter();

export const rateLimitMiddleware: Middleware<Context> = async (ctx, next) => {
  // Skip rate limiting for admin users
  if (config.adminIds.includes(Number(ctx.from?.id))) {
    await next();
    return;
  }

  if (rateLimiter.isLimited(ctx)) {
    const remaining = rateLimiter.getRemainingTime(ctx);
    logger.debug('Rate limit hit', { userId: ctx.from?.id });
    // Silently drop — don't reply to avoid encouraging spam
    if (remaining > 0) {
      await ctx.reply(
        `⚠️ Demasiados mensajes. Espera ${remaining} segundos.`,
      );
    }
    return;
  }

  await next();
};
