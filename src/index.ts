import { config, validateConfig } from './utils/config';
import { logger } from './utils/logger';
import { connectDatabase } from './models';
import { createBot, launchBot } from './bot/bot';
import { startRaffleScheduler } from './jobs/raffle-draw';
import { startCleanupScheduler } from './jobs/cleanup';
import { treasuryEngine } from './engine/treasury';
import { boltzClient } from './boltz/client';
import { initCNClient } from './changenow/client';
import { initWallet } from './engine/wallet';
import { BoltzWebSocket } from './boltz/websocket';

async function main(): Promise<void> {
  logger.info('Starting Telegram Swap Bot...', {
    commissionRate: config.commissionRate,
    boltzApiUrl: config.boltzApiUrl,
    adminCount: config.adminIds.length,
  });

  try {
    // Connect to MongoDB
    await connectDatabase();

    // Initialize treasury accounts
    await treasuryEngine.initialize();

    // Initialize BTC wallet for intermediary swaps
    const walletStatus = initWallet();
    logger.info('Wallet status', walletStatus);

    if (!walletStatus.initialized) {
      logger.warn('⚠️  WALLET NOT INITIALIZED — intermediary swaps DISABLED');
      logger.warn('   Set WALLET_BTC_PRIVATE_KEY (WIF format) to enable intermediary mode');
      logger.warn('   Swaps will use DIRECT mode (user sends to Boltz address)');
    }

    // Validate wallet config and show warnings
    const warnings = validateConfig(config);
    for (const w of warnings) {
      logger.warn(w);
    }

    // Start raffle scheduler (Sundays 23:59 UTC)
    startRaffleScheduler();

    // Start auto-cleanup for old stuck swaps
    startCleanupScheduler();

    // Enable Boltz Pro if configured (default: on)
    if (config.boltzProEnabled) {
      boltzClient.enablePro();
    } else {
      boltzClient.disablePro();
    }

    // Initialize ChangeNOW client for USDT/USDC swaps
    if (config.changenowApiKey) {
      initCNClient(config.changenowApiKey);
    } else {
      logger.warn('CHANGENOW_API_KEY not set — USDT/USDC swaps disabled');
    }

    // Connect to Boltz WebSocket (for real-time swap monitoring)
    const wsUrl = config.boltzApiUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/v2/ws';
    const boltzWs = new BoltzWebSocket(wsUrl);
    await boltzWs.connect();
    logger.info('Boltz WebSocket connected');

    // Create and launch bot
    const bot = createBot(boltzWs);
    await launchBot(bot);

    logger.info('Telegram Swap Bot is running');
  } catch (error) {
    logger.error('Fatal error during startup', { error });
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { error: reason });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
  process.exit(1);
});

main();
