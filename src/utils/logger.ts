import { config } from './config';

function log(level: string, message: string, meta?: unknown): void {
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
