import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  botToken: string;
  mongoUri: string;
  boltzApiUrl: string;
  commissionRate: number;
  adminIds: number[];
  logLevel: string;
  /** Enable Boltz Pro (dynamic fees based on liquidity) */
  boltzProEnabled: boolean;
  /** ChangeNOW API key for USDT/USDC swaps */
  changenowApiKey: string;
  /** Lightning address where all commissions go (e.g. admin@getalby.com) */
  lightningAddress: string;
  /** BTC on-chain address as fallback */
  btcAddress: string;
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
    /** Enable Boltz Pro for better rates on unbalanced liquidity */
    boltzProEnabled: process.env.BOLTZ_PRO_ENABLED !== 'false', // default: on
    /** ChangeNOW API key for USDT/USDC swaps */
    changenowApiKey: process.env.CHANGENOW_API_KEY || '',
    lightningAddress: process.env.WALLET_LIGHTNING_ADDRESS || '',
    btcAddress: process.env.WALLET_BTC_ADDRESS || '',
  };
}

export function validateConfig(config: Config): string[] {
  const warnings: string[] = [];
  if (!config.lightningAddress && !config.btcAddress) {
    warnings.push('No BTC/Lightning address configured — earnings cannot be tracked');
  }
  return warnings;
}

export const config = loadConfig();
