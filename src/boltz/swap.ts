import { randomBytes, createHash } from 'crypto';
import { boltzClient } from './client';
import { BoltzWebSocket } from './websocket';
import { logger } from '../utils/logger';
import type { BoltzSwapStatus, SubmarineSwapResponse, ReverseSwapResponse } from './types';

// --- Swap directions mapped to Boltz API calls ---

export type SwapDirection = 'USDT2BTC' | 'BTC2USDT' | 'USDC2BTC' | 'BTC2USDC' | 'LN2ONCHAIN' | 'ONCHAIN2LN';

export interface SwapParams {
  direction: SwapDirection;
  /** Amount in smallest unit (sats for BTC, cents for USDT/USDC) */
  amount: number;
  /** Lightning invoice (for submarine) */
  invoice?: string;
  /** Claim public key (for reverse swaps) */
  claimPublicKey?: string;
  /** Refund public key (for submarine) */
  refundPublicKey?: string;
}

export interface SwapResult {
  success: boolean;
  boltzSwapId: string;
  /** Address or invoice the user must pay */
  payToAddress?: string;
  payToInvoice?: string;
  /** Expected amount in smallest unit */
  expectedAmount: number;
  /** Bot commission in smallest unit */
  commissionAmount: number;
  /** Net amount after commission */
  netAmount: number;
  /** Final status */
  status: BoltzSwapStatus;
  /** Error message if failed */
  error?: string;
}

export class SwapOrchestrator {
  private ws: BoltzWebSocket;

  constructor(ws: BoltzWebSocket) {
    this.ws = ws;
  }

  /**
   * Execute a Boltz submarine swap (Chain → Lightning).
   * Used for: USDT/USDC → BTC (Lightning), or On-chain BTC → Lightning
   */
  async executeSubmarineSwap(params: SwapParams): Promise<SwapResult> {
    if (!params.invoice) {
      return { success: false, boltzSwapId: '', expectedAmount: 0, commissionAmount: 0, netAmount: 0, status: 'swap.expired', error: 'Invoice is required for submarine swaps' };
    }

    // TODO: replace with bitcoinjs-lib ECPair.makeRandom() in production
    const refundKey = randomBytes(32).toString('hex');
    const fromCurrency = params.direction.startsWith('USDT') ? 'USDT' : params.direction.startsWith('USDC') ? 'USDC' : 'BTC';
    const toCurrency = 'BTC';

    try {
      const response: SubmarineSwapResponse = await boltzClient.createSubmarineSwap({
        from: fromCurrency as any,
        to: toCurrency as any,
        invoice: params.invoice,
        refundPublicKey: params.refundPublicKey || refundKey,
      });

      return this.monitorSwap(response.id, params.amount, 'submarine');
    } catch (error) {
      logger.error('Submarine swap creation failed', { error });
      return {
        success: false,
        boltzSwapId: '',
        expectedAmount: params.amount,
        commissionAmount: 0,
        netAmount: 0,
        status: 'swap.expired',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Execute a Boltz reverse swap (Lightning → Chain).
   * Used for: BTC (Lightning) → USDT/USDC
   */
  async executeReverseSwap(params: SwapParams): Promise<SwapResult> {
    const preimage = randomBytes(32);
    const preimageHash = createHash('sha256').update(preimage).digest('hex');
    // TODO: replace with bitcoinjs-lib ECPair.makeRandom() in production
    const claimKey = randomBytes(32).toString('hex');

    const fromCurrency = 'BTC';
    const toCurrency = params.direction.startsWith('BTC2USDT') ? 'USDT' : 'USDC';

    try {
      const response: ReverseSwapResponse = await boltzClient.createReverseSwap({
        from: fromCurrency,
        to: toCurrency as any,
        invoiceAmount: params.amount,
        claimPublicKey: params.claimPublicKey || claimKey,
        preimageHash,
      });

      return this.monitorSwap(response.id, params.amount, 'reverse');
    } catch (error) {
      logger.error('Reverse swap creation failed', { error });
      return {
        success: false,
        boltzSwapId: '',
        expectedAmount: params.amount,
        commissionAmount: 0,
        netAmount: 0,
        status: 'swap.expired',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Monitor a swap via WebSocket until completion or failure.
   * Returns a promise that resolves when the swap reaches a final state.
   */
  private monitorSwap(
    swapId: string,
    amount: number,
    type: 'submarine' | 'reverse',
  ): Promise<SwapResult> {
    return new Promise((resolve) => {
      const timeoutMs = 30 * 60 * 1000; // 30 minute timeout
      let resolved = false;
      let timeout: NodeJS.Timeout;

      const finish = (result: SwapResult) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        this.ws.unsubscribe(swapId);
        resolve(result);
      };

      this.ws.subscribe(swapId, (_id, status) => {
        logger.info('Swap status update', { swapId, status });

        const terminalStatuses: BoltzSwapStatus[] = [
          'transaction.claimed',
          'invoice.settled',
          'invoice.failedToPay',
          'swap.expired',
          'transaction.lockupFailed',
          'transaction.failed',
          'transaction.refunded',
        ];

        if (terminalStatuses.includes(status)) {
          const success =
            status === 'transaction.claimed' || status === 'invoice.settled';

          finish({
            success,
            boltzSwapId: swapId,
            expectedAmount: amount,
            commissionAmount: 0, // Will be calculated by commission engine
            netAmount: amount,   // Will be adjusted by commission engine
            status,
            error: success
              ? undefined
              : `Swap terminó con estado: ${status}`,
          });
        }
      });

      // Timeout safety net
      timeout = setTimeout(() => {
        finish({
          success: false,
          boltzSwapId: swapId,
          expectedAmount: amount,
          commissionAmount: 0,
          netAmount: 0,
          status: 'swap.expired',
          error: 'Swap timeout after 30 minutes',
        });
      }, timeoutMs);
    });
  }
}

export function createSwapOrchestrator(ws: BoltzWebSocket): SwapOrchestrator {
  return new SwapOrchestrator(ws);
}
