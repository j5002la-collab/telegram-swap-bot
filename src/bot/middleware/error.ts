import { Context, Middleware } from 'telegraf';
import { logger } from '../../utils/logger';

interface ErrorSummary {
  type: string;
  message: string;
  stack?: string;
  updateType?: string;
  userId?: string;
  timestamp: string;
}

const errorLog: ErrorSummary[] = [];
const MAX_ERROR_LOG = 100;

/**
 * Record an error for admin inspection.
 */
export function getRecentErrors(limit = 10): ErrorSummary[] {
  return errorLog.slice(-limit);
}

/**
 * Clear error log.
 */
export function clearErrorLog(): void {
  errorLog.length = 0;
}

/**
 * Global error handler middleware.
 * Catches unhandled errors in bot handlers and logs them.
 */
export const errorMiddleware: Middleware<Context> = async (_ctx, next) => {
  try {
    await next();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const userId = _ctx.from?.id ? String(_ctx.from.id) : undefined;

    const summary: ErrorSummary = {
      type: error.name,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 3).join('\n'),
      updateType: _ctx.updateType,
      userId,
      timestamp: new Date().toISOString(),
    };

    errorLog.push(summary);
    if (errorLog.length > MAX_ERROR_LOG) {
      errorLog.shift();
    }

    logger.error('Unhandled bot error', {
      type: error.name,
      message: error.message,
      userId,
      updateType: _ctx.updateType,
    });

    // Try to respond to the user
    try {
      await _ctx.reply(
        '⚠️ Ocurrió un error inesperado. Intenta de nuevo o contacta a @admin.',
      );
    } catch {
      // Can't respond — probably a callback query without answer
    }
  }
};
