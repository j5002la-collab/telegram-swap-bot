import { config } from './config';

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level: string, message: string, meta?: unknown): void {
  const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;
  if (LEVELS[level] < currentLevel) return;
  const ts = new Date().toISOString().slice(11, 19);
  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  process.stderr.write(`[${ts}] ${level}: ${message}${metaStr}\n`);
}

export const logger = {
  debug: (msg: string, meta?: unknown) => log('debug', msg, meta),
  info: (msg: string, meta?: unknown) => log('info', msg, meta),
  warn: (msg: string, meta?: unknown) => log('warn', msg, meta),
  error: (msg: string, meta?: unknown) => log('error', msg, meta),
};
