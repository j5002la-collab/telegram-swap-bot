import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  botToken: string;
  mongoUri: string;
  boltzApiUrl: string;
  commissionRate: number;
  adminIds: number[];
  logLevel: string;
}

function parseAdminIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id));
}

export function loadConfig(): Config {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    throw new Error('BOT_TOKEN environment variable is required');
  }

  return {
    botToken,
    mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/telegram-swap-bot',
    boltzApiUrl: process.env.BOLTZ_API_URL || 'https://api.boltz.exchange',
    commissionRate: parseFloat(process.env.COMMISSION_RATE || '2.5'),
    adminIds: parseAdminIds(process.env.ADMIN_IDS),
    logLevel: process.env.LOG_LEVEL || 'info',
  };
}

export const config = loadConfig();
