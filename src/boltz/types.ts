// Boltz API v2 TypeScript types
// Based on https://api.docs.boltz.exchange/

// --- Currency identifiers ---
export type BoltzCurrency = 'BTC' | 'L-BTC' | 'RBTC' | 'TBTC' | 'USDT' | 'USDC' | 'ARK';

// --- Fee structure ---
export interface BoltzMinerFees {
  /** Boltz server miner fee in sats */
  server?: number;
  /** User-side miner fees */
  user?: {
    claim: number;
    lockup: number;
  };
  /** Simple miner fee total (for submarine) in sats */
  minerFees?: number;
}

export interface BoltzPairFees {
  percentage: number;
  minerFees: BoltzMinerFees | number;
}

export interface BoltzPairLimits {
  maximal: number;
  minimal: number;
  maximalZeroConf?: number;
  minimalBatched?: number;
}

export interface BoltzPair {
  hash: string;
  rate: number;
  limits: BoltzPairLimits;
  fees: BoltzPairFees;
}

// --- Submarine Swap (Chain → Lightning) ---
export interface SubmarineSwapRequest {
  from: BoltzCurrency;
  to: BoltzCurrency;
  /** Lightning invoice to be paid */
  invoice: string;
  /** Public key for refund path */
  refundPublicKey: string;
  /** Optional pair hash for fee validation */
  pairHash?: string;
}

export interface SubmarineSwapResponse {
  id: string;
  /** On-chain address to send funds to */
  address: string;
  /** Expected amount in sats */
  expectedAmount: number;
  /** Amount that can be claimed (actual received) */
  bip21?: string;
  /** Current swap rate */
  rate: number;
  /** Timeout block height */
  timeoutBlockHeight: number;
  /** Public key of Boltz for claim */
  claimPublicKey: string;
  /** Swap tree for Taproot */
  swapTree: unknown;
}

// --- Reverse Swap (Lightning → Chain) ---
export interface ReverseSwapRequest {
  from: BoltzCurrency;
  to: BoltzCurrency;
  /** Amount in sats to swap */
  invoiceAmount: number;
  /** Public key for claim */
  claimPublicKey: string;
  /** SHA256 hash of preimage */
  preimageHash: string;
  /** Address where Boltz should send the on-chain BTC after settlement */
  address?: string;
  pairHash?: string;
}

export interface ReverseSwapResponse {
  id: string;
  /** Lightning invoice to pay */
  invoice: string;
  /** Lockup address for Boltz's on-chain funds */
  lockupAddress: string;
  /** Expected on-chain amount */
  expectedAmount: number;
  rate: number;
  timeoutBlockHeight: number;
  refundPublicKey: string;
  swapTree: unknown;
}

// --- Chain Swap (Chain ↔ Chain) ---
export interface ChainSwapRequest {
  from: BoltzCurrency;
  to: BoltzCurrency;
  /** Amount in sats */
  userLockAmount: number;
  /** Public key for server claim */
  serverLockKey?: string;
  /** Public key for user claim */
  userLockKey?: string;
  pairHash?: string;
}

export interface ChainSwapResponse {
  id: string;
  /** Lockup address for the user (from chain) */
  lockupAddress: string;
  /** Lockup address for the server (to chain) */
  serverLockupAddress: string;
  /** Expected amount to lock */
  expectedAmount: number;
  rate: number;
  timeoutBlockHeight: number;
}

// --- Swap Status (WebSocket events) ---
export type SubmarineSwapStatus =
  | 'swap.created'
  | 'invoice.set'
  | 'transaction.mempool'
  | 'transaction.confirmed'
  | 'invoice.pending'
  | 'invoice.paid'
  | 'invoice.failedToPay'
  | 'transaction.claim.pending'
  | 'transaction.claimed'
  | 'transaction.lockupFailed'
  | 'swap.expired';

export type ReverseSwapStatus =
  | 'swap.created'
  | 'minerfee.paid'
  | 'transaction.mempool'
  | 'transaction.confirmed'
  | 'invoice.expired'
  | 'invoice.settled'
  | 'transaction.failed'
  | 'swap.expired'
  | 'transaction.refunded';

export type ChainSwapStatus =
  | 'swap.created'
  | 'transaction.mempool'
  | 'transaction.confirmed'
  | 'transaction.server.mempool'
  | 'transaction.server.confirmed'
  | 'transaction.claim.pending'
  | 'transaction.claimed'
  | 'transaction.lockupFailed'
  | 'swap.expired';

export type BoltzSwapStatus = SubmarineSwapStatus | ReverseSwapStatus | ChainSwapStatus;

// --- WebSocket ---
export interface BoltzWsSubscription {
  op: 'subscribe';
  channel: 'swap.update';
  args: [string]; // swap ID
}

export interface BoltzWsPayload {
  event: 'update' | 'subscribe' | 'error';
  channel?: string;
  args: [{
    id?: string;
    status: BoltzSwapStatus;
    zeroConfRejected?: boolean;
  }];
}

// --- API Response types ---
export type SubmarinePairs = Record<BoltzCurrency, Record<string, BoltzPair>>;
export type ReversePairs = Record<BoltzCurrency, Record<string, BoltzPair>>;
export type ChainPairs = Record<BoltzCurrency, Record<string, BoltzPair>>;
