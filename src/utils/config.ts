import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  botToken: string;
  mongoUri: string;
  boltzApiUrl: string;
  commissionRate: number;
  adminIds: number[];
  logLevel: string;
  /** Admin wallet addresses where commissions are sent */
  wallets: WalletConfig;
}

export interface WalletConfig {
  /** Lightning address for BTC/LN earnings (e.g., admin@getalby.com) */
  lightningAddress: string;
  /** On-chain BTC address (fallback) */
  btcAddress: string;
  /** USDT address (TRC-20 or ERC-20 or USDT0) */
  usdtAddress: string;
  /** USDC address (ERC-20 or USDT0) */
  usdcAddress: string;
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
    wallets: {
      lightningAddress: process.env.WALLET_LIGHTNING_ADDRESS || '',
      btcAddress: process.env.WALLET_BTC_ADDRESS || '',
      usdtAddress: process.env.WALLET_USDT_ADDRESS || '',
      usdcAddress: process.env.WALLET_USDC_ADDRESS || '',
    },
  };
}

export function validateConfig(config: Config): string[] {
  const warnings: string[] = [];

  if (!config.wallets.lightningAddress && !config.wallets.btcAddress) {
    warnings.push('No BTC/Lightning address configured — BTC earnings cannot be withdrawn');
  }
  if (!config.wallets.usdtAddress) {
    warnings.push('No USDT address configured — USDT earnings cannot be withdrawn');
  }
  if (!config.wallets.usdcAddress) {
    warnings.push('No USDC address configured — USDC earnings cannot be withdrawn');
  }

  return warnings;
}

export const config = loadConfig();
