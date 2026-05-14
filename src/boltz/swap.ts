import type { BoltzSwapStatus } from './types';
import type { SwapDirection } from '../models/Swap';

// --- Swap parameter and result types ---
// NOTE: SwapDirection is canonical in src/models/Swap.ts — import from there.
// SwapOrchestrator was removed; swap execution happens directly in
// src/bot/commands/swap.ts via boltzClient + WebSocket subscription.

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
